from __future__ import annotations

import importlib.util
import json
import os
import socket
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import List, Optional


REMOTE_DIR = Path(__file__).resolve().parents[1]
SCRIPT = REMOTE_DIR / "deployment.py"
CANONICAL_ROOT = Path("/home/heqing/resume-ai")
OLD_ID = "1" * 64
NEW_ID = "2" * 64


def load_deployment():
    spec = importlib.util.spec_from_file_location("remote_deployment", SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError("could not load deployment module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_release(root: Path, release_id: str) -> Path:
    release = root / "releases" / release_id
    release.mkdir(parents=True)
    (release / ".complete").write_bytes(f"{release_id}\n".encode("ascii"))
    return release


def make_install_fixture(base: Path):
    bundle = base / "private-bundle"
    asset_root = base / "deployment-assets"
    bundle.mkdir()
    (bundle / "payload.bin").write_bytes(b"verified-private-content")
    (asset_root / "bin").mkdir(parents=True)
    (asset_root / "systemd").mkdir()
    for name in ("deployment.py", "verify-assets.py", "env.example", "supervisord.conf"):
        (asset_root / name).write_text(name, encoding="ascii")
    for name in ("start-all.sh", "stop-all.sh"):
        (asset_root / "bin" / name).write_text(name, encoding="ascii")
    for name in ("resume-embedding.service", "resume-ocr.service"):
        (asset_root / "systemd" / name).write_text(name, encoding="ascii")
    return bundle, asset_root


def inject_release_switch(deployment, initial_release_id: Optional[str]):
    state = {"current": initial_release_id}
    original_current = deployment.current_release_id
    original_activate = deployment.activate_release

    deployment.current_release_id = lambda _root: state["current"]

    def activate(_root: Path, release_id: str) -> None:
        deployment.validate_release(_root, release_id)
        state["current"] = release_id

    deployment.activate_release = activate
    return state, original_current, original_activate


class FakeController:
    def __init__(self, events: List[str], fail_stop_at: Optional[int] = None) -> None:
        self.events = events
        self.fail_stop_at = fail_stop_at
        self.stop_calls = 0

    def stop(self) -> None:
        self.stop_calls += 1
        self.events.append("stop")
        if self.fail_stop_at == self.stop_calls:
            raise RuntimeError("stop failed")

    def start(self) -> None:
        self.events.append("start")

    def status(self) -> None:
        self.events.append("status")


class DeploymentLifecycleTests(unittest.TestCase):
    def test_install_runs_complete_transaction_with_fake_host_boundaries(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "resume-ai"
            bundle, asset_root = make_install_fixture(base)
            events = []
            state = {"current": None}

            def verifier(path: Path, _asset_root: Path) -> str:
                events.append("verify:" + path.name)
                return deployment.hashlib.sha256((path / "payload.bin").read_bytes()).hexdigest()

            def build(_conda, _snapshot, _assets, release, release_id):
                events.append("build")
                release.mkdir(parents=True)
                (release / ".complete").write_bytes((release_id + "\n").encode("ascii"))

            def published(check_root: Path, release_id: str) -> Path:
                events.append("published:" + release_id)
                return deployment.validate_release(check_root, release_id)

            controller = FakeController(events)
            replacements = {
                "current_user_name": lambda: "heqing",
                "validate_root_path": lambda path: path,
                "verify_assets": verifier,
                "_host_preflight": lambda: events.append("host"),
                "_conda_preflight": lambda _conda, _python: events.append("conda") or [],
                "_disk_preflight": lambda _parent: events.append("disk"),
                "systemd_available": lambda: False,
                "_build_release": build,
                "validate_installed_release": lambda *_args: events.append("installed"),
                "validate_published_release": published,
                "_ensure_runtime_links": lambda _root: events.append("links"),
                "_ensure_token": lambda path: events.append("token:" + path.name),
                "controller_for": lambda _root, _metadata: controller,
                "current_release_id": lambda _root: state["current"],
                "activate_release": lambda _root, release_id: state.__setitem__("current", release_id),
                "verify_workers_ready": lambda _root, release_id, timeout=None: events.append(
                    "ready:" + release_id
                ),
            }
            originals = {name: getattr(deployment, name) for name in replacements}
            for name, value in replacements.items():
                setattr(deployment, name, value)
            try:
                deployment._install(SimpleNamespace(root=str(root), bundle=str(bundle)), asset_root)
            finally:
                for name, value in originals.items():
                    setattr(deployment, name, value)

            self.assertEqual(state["current"], deployment.deployment_fingerprint(asset_root, verifier(bundle, asset_root)))
            self.assertTrue((root / "controller" / "owner.json").is_file())
            self.assertIn("token:embedding.token", events)
            self.assertIn("token:ocr.token", events)
            self.assertIn("build", events)
            self.assertIn("start", events)
            self.assertIn("status", events)
            self.assertTrue(any(event.startswith("ready:") for event in events))

    def test_install_detects_bundle_mutation_between_initial_verify_and_staging(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "resume-ai"
            bundle, asset_root = make_install_fixture(base)
            verify_calls = [0]
            built = []

            def verifier(path: Path, _asset_root: Path) -> str:
                verify_calls[0] += 1
                digest = deployment.hashlib.sha256((path / "payload.bin").read_bytes()).hexdigest()
                if verify_calls[0] == 1:
                    (bundle / "payload.bin").write_bytes(b"mutated-after-verification")
                return digest

            replacements = {
                "current_user_name": lambda: "heqing",
                "validate_root_path": lambda path: path,
                "verify_assets": verifier,
                "_host_preflight": lambda: None,
                "_conda_preflight": lambda _conda, _python: [],
                "_disk_preflight": lambda _parent: None,
                "systemd_available": lambda: False,
                "_build_release": lambda *_args: built.append(True),
            }
            originals = {name: getattr(deployment, name) for name in replacements}
            for name, value in replacements.items():
                setattr(deployment, name, value)
            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "changed while staging"):
                    deployment._install(SimpleNamespace(root=str(root), bundle=str(bundle)), asset_root)
            finally:
                for name, value in originals.items():
                    setattr(deployment, name, value)

            self.assertEqual(verify_calls, [2])
            self.assertEqual(built, [])
            self.assertFalse(any((root / "releases").iterdir()))

    def test_install_activation_failure_restores_previous_release_transactionally(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "resume-ai"
            bundle, asset_root = make_install_fixture(base)
            make_release(root, OLD_ID)
            events = []
            state = {"current": OLD_ID}
            activation_calls = [0]

            def verifier(path: Path, _asset_root: Path) -> str:
                return deployment.hashlib.sha256((path / "payload.bin").read_bytes()).hexdigest()

            def build(_conda, _snapshot, _assets, release, release_id):
                release.mkdir(parents=True)
                (release / ".complete").write_bytes((release_id + "\n").encode("ascii"))

            def activate(_root: Path, release_id: str) -> None:
                activation_calls[0] += 1
                if activation_calls[0] == 1:
                    raise OSError("replace failed")
                state["current"] = release_id

            controller = FakeController(events)
            replacements = {
                "current_user_name": lambda: "heqing",
                "validate_root_path": lambda path: path,
                "verify_assets": verifier,
                "_host_preflight": lambda: None,
                "_conda_preflight": lambda _conda, _python: [],
                "_disk_preflight": lambda _parent: None,
                "systemd_available": lambda: False,
                "_build_release": build,
                "validate_installed_release": lambda *_args: None,
                "validate_published_release": lambda check_root, release_id: deployment.validate_release(
                    check_root, release_id
                ),
                "_ensure_runtime_links": lambda _root: None,
                "_ensure_token": lambda _path: None,
                "controller_for": lambda _root, _metadata: controller,
                "current_release_id": lambda _root: state["current"],
                "activate_release": activate,
                "verify_workers_ready": lambda _root, release_id, timeout=None: events.append(
                    "ready:" + release_id
                ),
            }
            originals = {name: getattr(deployment, name) for name in replacements}
            for name, value in replacements.items():
                setattr(deployment, name, value)
            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "previous release restored"):
                    deployment._install(SimpleNamespace(root=str(root), bundle=str(bundle)), asset_root)
            finally:
                for name, value in originals.items():
                    setattr(deployment, name, value)

            self.assertEqual(state["current"], OLD_ID)
            self.assertEqual(events, ["stop", "stop", "start", "status", "ready:" + OLD_ID])
            self.assertTrue((root / "releases" / OLD_ID).is_dir())
            self.assertEqual(len(list((root / "releases").iterdir())), 2)

    def test_manual_rollback_requires_published_release_contents_not_marker_alone(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            make_release(root, OLD_ID)
            with self.assertRaisesRegex(deployment.DeploymentError, "published release"):
                deployment.validate_published_release(root, OLD_ID)

    def test_supervisor_start_polls_starting_until_both_workers_run(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            (root / "envs" / "embedding" / "bin").mkdir(parents=True)
            (root / "run").mkdir()
            (root / "services").mkdir()
            for name in ("supervisord", "supervisorctl"):
                executable = root / "envs" / "embedding" / "bin" / name
                executable.write_text("fixture", encoding="ascii")
                executable.chmod(0o700)
            config = root / "services" / "supervisord.conf"
            config.write_text("startsecs=2\n", encoding="ascii")
            states = iter(
                [
                    "resume-embedding STARTING pid 1\nresume-ocr STARTING pid 2\n",
                    "resume-embedding RUNNING pid 1\nresume-ocr RUNNING pid 2\n",
                ]
            )
            calls = []

            def run(arguments, **kwargs):
                calls.append(list(arguments))
                if arguments[0].endswith("supervisorctl"):
                    return type("Result", (), {"stdout": next(states)})()
                return type("Result", (), {"stdout": ""})()

            controller = deployment.SupervisorController(
                root,
                run=run,
                process_is_owned=lambda _pid, _config: True,
                poll_interval=0,
                start_timeout=1,
                sleep=lambda _seconds: None,
            )
            controller.start()

            self.assertEqual(sum("status" in call for call in calls), 2)

    def test_supervisor_stop_polls_workers_and_supervisord_to_termination(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            (root / "envs" / "embedding" / "bin").mkdir(parents=True)
            (root / "run").mkdir()
            (root / "services").mkdir()
            for name in ("supervisord", "supervisorctl"):
                executable = root / "envs" / "embedding" / "bin" / name
                executable.write_text("fixture", encoding="ascii")
                executable.chmod(0o700)
            (root / "services" / "supervisord.conf").write_text("fixture", encoding="ascii")
            (root / "run" / "supervisord.pid").write_text("123\n", encoding="ascii")
            owned = [True]
            states = iter(
                [
                    "resume-embedding STOPPING pid 1\nresume-ocr STOPPING pid 2\n",
                    "resume-embedding EXITED exit status 0\nresume-ocr EXITED exit status 0\n",
                ]
            )
            calls = []

            def run(arguments, **kwargs):
                calls.append(list(arguments))
                if arguments[-1] == "shutdown":
                    return type("Result", (), {"stdout": ""})()
                owned[0] = False
                return type("Result", (), {"stdout": next(states)})()

            controller = deployment.SupervisorController(
                root,
                run=run,
                process_is_owned=lambda _pid, _config: owned[0],
                poll_interval=0,
                stop_timeout=1,
                sleep=lambda _seconds: None,
            )
            controller.stop()

            self.assertGreaterEqual(sum("status" in call for call in calls), 2)
            self.assertFalse((root / "run" / "supervisord.pid").exists())

    def test_supervisor_start_rejects_fatal_worker_state(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            (root / "envs" / "embedding" / "bin").mkdir(parents=True)
            (root / "run").mkdir()
            (root / "services").mkdir()
            for name in ("supervisord", "supervisorctl"):
                executable = root / "envs" / "embedding" / "bin" / name
                executable.write_text("fixture", encoding="ascii")
                executable.chmod(0o700)
            (root / "services" / "supervisord.conf").write_text("startsecs=1\n", encoding="ascii")

            def run(arguments, **_kwargs):
                if arguments[0].endswith("supervisorctl"):
                    return type(
                        "Result",
                        (),
                        {"stdout": "resume-embedding FATAL exited\nresume-ocr STARTING pid 2\n"},
                    )()
                return type("Result", (), {"stdout": ""})()

            controller = deployment.SupervisorController(
                root,
                run=run,
                process_is_owned=lambda _pid, _config: False,
                poll_interval=0,
                start_timeout=1,
                sleep=lambda _seconds: None,
            )
            with self.assertRaisesRegex(deployment.DeploymentError, "failed during startup"):
                controller.start()

    def test_activation_failure_restores_previous_release_and_restarts_workers(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            make_release(root, OLD_ID)
            make_release(root, NEW_ID)
            state, original_current, original_activate = inject_release_switch(deployment, OLD_ID)
            events: List[str] = []
            controller = FakeController(events)
            calls = [0]

            def activate(_root: Path, release_id: str) -> None:
                calls[0] += 1
                if calls[0] == 1:
                    raise OSError("atomic activation failed")
                state["current"] = release_id

            deployment.activate_release = activate
            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "activation failed"):
                    deployment.transactional_activate(root, NEW_ID, controller, lambda _id: None)
            finally:
                deployment.current_release_id = original_current
                deployment.activate_release = original_activate

            self.assertEqual(state["current"], OLD_ID)
            self.assertEqual(events, ["stop", "stop", "start", "status"])

    def test_build_release_validates_before_writing_completion_marker(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            snapshot = base / "snapshot"
            asset_root = base / "assets"
            release = base / "releases" / NEW_ID
            for path in (
                snapshot / "models" / "Qwen3-Embedding-8B",
                snapshot / "models" / "DeepSeek-OCR-2",
                snapshot / "workers" / "embedding-worker",
                snapshot / "workers" / "ocr-worker",
                asset_root / "bin",
                asset_root / "systemd",
            ):
                path.mkdir(parents=True)
            for worker in ("embedding-worker", "ocr-worker"):
                (snapshot / "workers" / worker / "worker-manifest.json").write_text(
                    json.dumps({"wheel": "worker.whl"}), encoding="ascii"
                )
                (snapshot / "workers" / worker / "worker.whl").write_bytes(b"wheel")
                (snapshot / "workers" / worker / "requirements.lock").write_text("", encoding="ascii")
            (snapshot / "models" / "Qwen3-Embedding-8B" / "weights.bin").write_bytes(b"qwen")
            (snapshot / "models" / "DeepSeek-OCR-2" / "weights.bin").write_bytes(b"ocr")
            for name in ("deployment.py", "verify-assets.py", "supervisord.conf", "env.example"):
                (asset_root / name).write_text(name, encoding="ascii")
            for name in ("run-embedding.sh", "run-ocr.sh"):
                (asset_root / "bin" / name).write_text(name, encoding="ascii")
            for name in ("resume-embedding.service", "resume-ocr.service"):
                (asset_root / "systemd" / name).write_text(name, encoding="ascii")

            observed = []

            def fake_environment(_conda, _snapshot, build_root, name, *_args):
                python = build_root / "envs" / name / "bin" / "python"
                python.parent.mkdir(parents=True, exist_ok=True)
                python.write_text("python", encoding="ascii")
                python.chmod(0o700)
                supervisor = build_root / "envs" / "embedding" / "bin" / "supervisord"
                supervisor.write_text("supervisor", encoding="ascii")
                supervisor.chmod(0o700)

            def fake_validate(_snapshot, _assets, build_root):
                observed.append((build_root / ".complete").exists())

            original_environment = deployment._create_environment
            original_validate = deployment.validate_installed_release
            deployment._create_environment = fake_environment
            deployment.validate_installed_release = fake_validate
            try:
                deployment._build_release("conda", snapshot, asset_root, release, NEW_ID)
            finally:
                deployment._create_environment = original_environment
                deployment.validate_installed_release = original_validate

            self.assertEqual(observed, [False])
            self.assertTrue((release / ".complete").is_file())

    def test_post_build_validation_failure_never_publishes_completion_marker(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            snapshot = base / "snapshot"
            asset_root = base / "assets"
            release = base / "releases" / NEW_ID
            for path in (
                snapshot / "models" / "Qwen3-Embedding-8B",
                snapshot / "models" / "DeepSeek-OCR-2",
                snapshot / "workers" / "embedding-worker",
                snapshot / "workers" / "ocr-worker",
                asset_root / "bin",
                asset_root / "systemd",
            ):
                path.mkdir(parents=True)
            for worker in ("embedding-worker", "ocr-worker"):
                (snapshot / "workers" / worker / "worker-manifest.json").write_text(
                    json.dumps({"wheel": "worker.whl"}), encoding="ascii"
                )
                (snapshot / "workers" / worker / "worker.whl").write_bytes(b"wheel")
                (snapshot / "workers" / worker / "requirements.lock").write_text("", encoding="ascii")
            for model in ("Qwen3-Embedding-8B", "DeepSeek-OCR-2"):
                (snapshot / "models" / model / "weights.bin").write_bytes(model.encode("ascii"))
            for name in ("deployment.py", "verify-assets.py", "supervisord.conf", "env.example"):
                (asset_root / name).write_text(name, encoding="ascii")
            for name in ("run-embedding.sh", "run-ocr.sh"):
                (asset_root / "bin" / name).write_text(name, encoding="ascii")
            for name in ("resume-embedding.service", "resume-ocr.service"):
                (asset_root / "systemd" / name).write_text(name, encoding="ascii")

            def fake_environment(_conda, _snapshot, build_root, name, *_args):
                executable = build_root / "envs" / name / "bin" / "python"
                executable.parent.mkdir(parents=True, exist_ok=True)
                executable.write_text("python", encoding="ascii")
                executable.chmod(0o700)
                supervisor = build_root / "envs" / "embedding" / "bin" / "supervisord"
                supervisor.write_text("supervisor", encoding="ascii")
                supervisor.chmod(0o700)

            original_environment = deployment._create_environment
            original_validate = deployment.validate_installed_release
            deployment._create_environment = fake_environment
            deployment.validate_installed_release = lambda *_args: (_ for _ in ()).throw(
                deployment.DeploymentError("post-build validation failed")
            )
            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "post-build"):
                    deployment._build_release("conda", snapshot, asset_root, release, NEW_ID)
            finally:
                deployment._create_environment = original_environment
                deployment.validate_installed_release = original_validate

            self.assertFalse(release.exists())
            self.assertFalse((snapshot.parent / "release" / ".complete").exists())

    def test_lifecycle_rejects_non_heqing_before_filesystem_access(self) -> None:
        deployment = load_deployment()
        original_user = deployment.current_user_name
        deployment.current_user_name = lambda: "root"
        try:
            with self.assertRaisesRegex(deployment.DeploymentError, "heqing"):
                deployment._control("status", Path("relative-root"))
        finally:
            deployment.current_user_name = original_user

    def test_every_lifecycle_entrypoint_rejects_non_heqing(self) -> None:
        deployment = load_deployment()
        original_user = deployment.current_user_name
        original_prepare = deployment.prepare_install
        deployment.current_user_name = lambda: "root"
        deployment.prepare_install = lambda _root, _bundle, _assets: SimpleNamespace(
            root=Path("relative-root"),
            bundle=Path("bundle"),
            asset_root=REMOTE_DIR,
            bundle_fingerprint="a" * 64,
            deployment_id="b" * 64,
        )
        try:
            for command in ("start", "stop", "status"):
                with self.subTest(command=command):
                    with self.assertRaisesRegex(deployment.DeploymentError, "heqing"):
                        deployment._control(command, Path("relative-root"))
            with self.assertRaisesRegex(deployment.DeploymentError, "heqing"):
                deployment._rollback(Path("relative-root"), OLD_ID)
            with self.assertRaisesRegex(deployment.DeploymentError, "heqing"):
                deployment._install(
                    SimpleNamespace(root="relative-root", bundle="bundle"),
                    REMOTE_DIR,
                )
        finally:
            deployment.current_user_name = original_user
            deployment.prepare_install = original_prepare

    def test_foreign_owned_managed_path_is_rejected(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            original_owned = deployment.path_is_owned
            original_validate = deployment.validate_root_path
            deployment.path_is_owned = lambda _path: False
            deployment.validate_root_path = lambda path: path
            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "owned"):
                    deployment.preflight_managed_paths(root, NEW_ID, Path(temporary))
            finally:
                deployment.path_is_owned = original_owned
                deployment.validate_root_path = original_validate

    def test_controller_metadata_temp_file_is_exclusive(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            directory = root / "controller"
            directory.mkdir(parents=True)
            temporary_path = directory / (".owner.json." + str(os.getpid()))
            temporary_path.write_text("attacker", encoding="ascii")
            with self.assertRaisesRegex(deployment.DeploymentError, "temporary"):
                deployment.persist_controller_metadata(root, "supervisor")
            self.assertEqual(temporary_path.read_text(encoding="ascii"), "attacker")

    def test_token_temp_file_is_exclusive(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "embedding.token"
            temporary_path = path.parent / ("." + path.name + "." + str(os.getpid()))
            temporary_path.write_text("attacker", encoding="ascii")
            with self.assertRaisesRegex(deployment.DeploymentError, "temporary"):
                deployment._ensure_token(path)
            self.assertEqual(temporary_path.read_text(encoding="ascii"), "attacker")

    def test_asset_verification_precedes_root_and_preflight_validation(self) -> None:
        deployment = load_deployment()
        events: List[str] = []

        def verifier(_bundle: Path) -> str:
            events.append("verify")
            return "a" * 64

        def preflight(_plan) -> None:
            events.append("preflight")

        with self.assertRaisesRegex(deployment.DeploymentError, "installation root"):
            deployment.prepare_install(
                Path("relative-root"),
                Path("bundle"),
                REMOTE_DIR,
                verifier=verifier,
                preflight=preflight,
            )

        self.assertEqual(events, ["verify"])

    def test_verified_staging_rejects_bundle_toctou(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            bundle = base / "bundle"
            staging_parent = base / "staging"
            bundle.mkdir()
            (bundle / "asset").write_text("verified", encoding="ascii")
            staging_parent.mkdir()

            with self.assertRaisesRegex(deployment.DeploymentError, "changed while staging"):
                deployment.stage_verified_bundle(
                    bundle,
                    staging_parent,
                    "a" * 64,
                    verifier=lambda _path: "b" * 64,
                )

            self.assertFalse(any(staging_parent.iterdir()))

    def test_preflight_rejects_invalid_current_without_mutation(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            root.mkdir()
            (root / "current").write_text("operator data", encoding="ascii")
            before = sorted(path.relative_to(root) for path in root.rglob("*"))

            original_validate = deployment.validate_root_path
            deployment.validate_root_path = lambda path: path
            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "current"):
                    deployment.preflight_managed_paths(root, NEW_ID, Path(temporary))
            finally:
                deployment.validate_root_path = original_validate

            after = sorted(path.relative_to(root) for path in root.rglob("*"))
            self.assertEqual(after, before)

    def test_preflight_rejects_managed_log_directory_without_mutation(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            bad_log = root / "logs" / "embedding.stderr.log"
            bad_log.mkdir(parents=True)
            before = sorted(path.relative_to(root) for path in root.rglob("*"))
            original_validate = deployment.validate_root_path
            deployment.validate_root_path = lambda path: path

            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "log file"):
                    deployment.preflight_managed_paths(root, NEW_ID, Path(temporary))
            finally:
                deployment.validate_root_path = original_validate

            after = sorted(path.relative_to(root) for path in root.rglob("*"))
            self.assertEqual(after, before)

    def test_preflight_validates_existing_candidate_release_marker(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            release = make_release(root, NEW_ID)
            (release / ".complete").write_bytes(b"wrong\n")
            original_validate = deployment.validate_root_path
            deployment.validate_root_path = lambda path: path

            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "completion marker"):
                    deployment.preflight_managed_paths(root, NEW_ID, Path(temporary))
            finally:
                deployment.validate_root_path = original_validate

    def test_preflight_validates_every_existing_managed_release(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            make_release(root, NEW_ID)
            malformed = root / "releases" / ("f" * 64)
            malformed.mkdir()
            (malformed / ".complete").write_bytes(b"wrong\n")
            original_validate = deployment.validate_root_path
            deployment.validate_root_path = lambda path: path

            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "completion marker"):
                    deployment.preflight_managed_paths(root, NEW_ID, Path(temporary))
            finally:
                deployment.validate_root_path = original_validate

    def test_install_lock_is_acquired_exclusively_and_leaves_no_residue(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            lock_path = Path(temporary) / ".resume-ai.install.lock"

            with deployment.InstallLock(root):
                self.assertTrue(lock_path.is_file())
                with self.assertRaisesRegex(deployment.DeploymentError, "already running"):
                    with deployment.InstallLock(root):
                        pass

            self.assertFalse(lock_path.exists())

    def test_first_install_does_not_stop_nonexistent_systemd_units(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            make_release(root, NEW_ID)
            state, original_current, original_activate = inject_release_switch(deployment, None)
            events: List[str] = []
            controller = FakeController(events, fail_stop_at=1)

            try:
                deployment.transactional_activate(root, NEW_ID, controller, lambda _release_id: None)
            finally:
                deployment.current_release_id = original_current
                deployment.activate_release = original_activate

            self.assertEqual(events, ["start", "status"])
            self.assertEqual(state["current"], NEW_ID)

    def test_upgrade_stops_switches_starts_and_verifies_both_workers(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            make_release(root, OLD_ID)
            make_release(root, NEW_ID)
            state, original_current, original_activate = inject_release_switch(deployment, OLD_ID)
            events: List[str] = []
            controller = FakeController(events)

            def ready(release_id: str) -> None:
                events.append(f"ready:{release_id}:embedding")
                events.append(f"ready:{release_id}:ocr")

            try:
                deployment.transactional_activate(root, NEW_ID, controller, ready)
            finally:
                deployment.current_release_id = original_current
                deployment.activate_release = original_activate

            self.assertEqual(
                events,
                ["stop", "start", "status", f"ready:{NEW_ID}:embedding", f"ready:{NEW_ID}:ocr"],
            )
            self.assertEqual(state["current"], NEW_ID)

    def test_startup_failure_restores_and_verifies_previous_release(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            make_release(root, OLD_ID)
            make_release(root, NEW_ID)
            state, original_current, original_activate = inject_release_switch(deployment, OLD_ID)
            events: List[str] = []
            controller = FakeController(events)

            def ready(release_id: str) -> None:
                events.append(f"ready:{release_id}")
                if release_id == NEW_ID:
                    raise RuntimeError("new worker failed")

            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "previous release restored"):
                    deployment.transactional_activate(root, NEW_ID, controller, ready)
            finally:
                deployment.current_release_id = original_current
                deployment.activate_release = original_activate

            self.assertEqual(
                events,
                [
                    "stop",
                    "start",
                    "status",
                    f"ready:{NEW_ID}",
                    "stop",
                    "start",
                    "status",
                    f"ready:{OLD_ID}",
                ],
            )
            self.assertEqual(state["current"], OLD_ID)
            self.assertTrue((root / "releases" / NEW_ID).is_dir())

    def test_rollback_failure_preserves_both_releases_and_reports_loudly(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            make_release(root, OLD_ID)
            make_release(root, NEW_ID)
            _state, original_current, original_activate = inject_release_switch(deployment, OLD_ID)
            events: List[str] = []
            controller = FakeController(events)

            def never_ready(release_id: str) -> None:
                events.append(f"ready:{release_id}")
                raise RuntimeError(f"{release_id} failed")

            try:
                with self.assertRaisesRegex(deployment.RollbackError, "ROLLBACK FAILED"):
                    deployment.transactional_activate(root, NEW_ID, controller, never_ready)
            finally:
                deployment.current_release_id = original_current
                deployment.activate_release = original_activate

            self.assertTrue((root / "releases" / OLD_ID).is_dir())
            self.assertTrue((root / "releases" / NEW_ID).is_dir())

    def test_partial_new_process_stop_failure_does_not_switch_back_or_delete(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            make_release(root, OLD_ID)
            make_release(root, NEW_ID)
            state, original_current, original_activate = inject_release_switch(deployment, OLD_ID)
            controller = FakeController([], fail_stop_at=2)

            try:
                with self.assertRaisesRegex(deployment.RollbackError, "ROLLBACK FAILED"):
                    deployment.transactional_activate(
                        root,
                        NEW_ID,
                        controller,
                        lambda _release_id: (_ for _ in ()).throw(RuntimeError("not ready")),
                    )
            finally:
                deployment.current_release_id = original_current
                deployment.activate_release = original_activate

            self.assertEqual(state["current"], NEW_ID)
            self.assertTrue((root / "releases" / NEW_ID).is_dir())

    def test_release_validation_is_exact_and_rejects_symlinks(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            valid = make_release(root, OLD_ID)
            self.assertEqual(deployment.validate_release(root, OLD_ID), valid)

            for invalid in ("A" * 64, "a" * 63, "g" * 64, "-" + "a" * 63):
                with self.subTest(release_id=invalid):
                    with self.assertRaises(deployment.DeploymentError):
                        deployment.validate_release(root, invalid)

            (valid / ".complete").write_bytes(f"{OLD_ID}\n\n".encode("ascii"))
            with self.assertRaisesRegex(deployment.DeploymentError, "completion marker"):
                deployment.validate_release(root, OLD_ID)

    def test_existing_release_reuse_revalidates_verified_model_snapshot(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "resume-ai"
            release = make_release(root, OLD_ID)
            snapshot = base / "snapshot"
            asset_root = base / "assets"
            for model in ("Qwen3-Embedding-8B", "DeepSeek-OCR-2"):
                source = snapshot / "models" / model
                installed = release / "models" / model
                source.mkdir(parents=True)
                installed.mkdir(parents=True)
                (source / "weights.bin").write_bytes(b"verified")
                (installed / "weights.bin").write_bytes(b"mutated")
            (release / "services").mkdir()
            (release / "envs" / "embedding" / "bin").mkdir(parents=True)
            (release / "envs" / "ocr" / "bin").mkdir(parents=True)

            with self.assertRaisesRegex(deployment.DeploymentError, "verified snapshot"):
                deployment.validate_installed_release(snapshot, asset_root, release)

    @unittest.skipIf(os.name == "nt", "directory symlink creation requires elevated Windows privileges")
    def test_release_directory_must_not_be_a_symlink(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            outside = Path(temporary) / "outside"
            make_release(root, OLD_ID)
            make_release(root, NEW_ID)
            outside.mkdir()
            (root / "releases" / NEW_ID / ".complete").unlink()
            (root / "releases" / NEW_ID).rmdir()
            (root / "releases" / NEW_ID).symlink_to(outside, target_is_directory=True)

            with self.assertRaisesRegex(deployment.DeploymentError, "direct non-symlink"):
                deployment.validate_release(root, NEW_ID)

    @unittest.skipIf(os.name == "nt", "symbolic links require elevated Windows privileges")
    def test_current_target_must_be_exact_managed_release(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            make_release(root, OLD_ID)
            root.joinpath("current").symlink_to(Path("../outside"), target_is_directory=True)

            with self.assertRaisesRegex(deployment.DeploymentError, "current"):
                deployment.current_release_id(root)

    def test_controller_selection_is_persisted_and_custom_root_never_probes_systemd(self) -> None:
        deployment = load_deployment()
        probes: List[str] = []
        with tempfile.TemporaryDirectory() as temporary:
            custom = Path(temporary) / "resume-ai"
            selected = deployment.select_controller(
                custom,
                existing=None,
                systemd_probe=lambda: probes.append("systemd") or True,
            )
            self.assertEqual(selected, "supervisor")
            self.assertEqual(probes, [])

            persisted = deployment.ControllerMetadata(str(custom), "supervisor")
            self.assertEqual(
                deployment.select_controller(custom, persisted, lambda: True),
                "supervisor",
            )

            with self.assertRaisesRegex(deployment.DeploymentError, "canonical root"):
                deployment.select_controller(
                    custom,
                    deployment.ControllerMetadata(str(custom), "systemd"),
                    lambda: True,
                )

    def test_controller_metadata_rejects_wrong_root_and_unknown_backend(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            metadata_dir = root / "controller"
            metadata_dir.mkdir(parents=True)
            metadata_path = metadata_dir / "owner.json"

            metadata_path.write_text(
                json.dumps({"version": 1, "root": "/different", "backend": "supervisor"}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(deployment.DeploymentError, "ownership"):
                deployment.load_controller_metadata(root)

            metadata_path.write_text(
                json.dumps({"version": 1, "root": str(root), "backend": "other"}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(deployment.DeploymentError, "backend"):
                deployment.load_controller_metadata(root)

    def test_systemd_stop_failure_is_propagated(self) -> None:
        deployment = load_deployment()
        calls: List[List[str]] = []

        def run(arguments, **_kwargs):
            calls.append(list(arguments))
            raise deployment.CommandError("systemctl stop failed")

        controller = deployment.SystemdController(CANONICAL_ROOT, run=run)
        with self.assertRaisesRegex(deployment.CommandError, "stop failed"):
            controller.stop()

        self.assertEqual(
            calls,
            [["systemctl", "--user", "stop", "resume-embedding.service", "resume-ocr.service"]],
        )

    def test_systemd_start_installs_both_units_and_uses_fake_commands(self) -> None:
        deployment = load_deployment()
        calls: List[List[str]] = []

        def run(arguments, **_kwargs):
            calls.append(list(arguments))
            return type("Result", (), {"stdout": ""})()

        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            source_root = Path(temporary) / "canonical"
            systemd = source_root / "services" / "systemd"
            systemd.mkdir(parents=True)
            for unit in ("resume-embedding.service", "resume-ocr.service"):
                (systemd / unit).write_text(unit, encoding="ascii")

            controller = deployment.SystemdController.__new__(deployment.SystemdController)
            controller.root = source_root
            controller.run = run
            controller.home = home
            controller.start()
            controller.status()

            installed = home / ".config" / "systemd" / "user"
            self.assertEqual((installed / "resume-embedding.service").read_text(), "resume-embedding.service")
            self.assertEqual((installed / "resume-ocr.service").read_text(), "resume-ocr.service")
            self.assertEqual(
                calls,
                [
                    ["systemctl", "--user", "daemon-reload"],
                    [
                        "systemctl",
                        "--user",
                        "enable",
                        "--now",
                        "resume-embedding.service",
                        "resume-ocr.service",
                    ],
                    [
                        "systemctl",
                        "--user",
                        "status",
                        "resume-embedding.service",
                        "resume-ocr.service",
                        "--no-pager",
                    ],
                ],
            )

    def test_supervisor_start_uses_only_owned_state_and_fake_command(self) -> None:
        deployment = load_deployment()
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            bin_dir = root / "envs" / "embedding" / "bin"
            run_dir = root / "run"
            services = root / "services"
            bin_dir.mkdir(parents=True)
            run_dir.mkdir(parents=True)
            services.mkdir(parents=True)
            supervisord = bin_dir / "supervisord"
            supervisorctl = bin_dir / "supervisorctl"
            for executable in (supervisord, supervisorctl):
                executable.write_text("fixture", encoding="ascii")
                executable.chmod(0o700)
            (services / "supervisord.conf").write_text("fixture", encoding="ascii")

            def run(arguments, **kwargs):
                calls.append((list(arguments), kwargs.get("env", {}).get("RESUME_AI_ROOT")))
                return type(
                    "Result",
                    (),
                    {"stdout": "resume-embedding RUNNING pid 1\nresume-ocr RUNNING pid 2\n"},
                )()

            controller = deployment.SupervisorController(
                root,
                run=run,
                process_is_owned=lambda _pid, _config: False,
            )
            controller.start()

            self.assertEqual(
                calls,
                [
                    ([str(supervisord), "-c", str(services / "supervisord.conf")], str(root)),
                    ([str(supervisorctl), "-c", str(services / "supervisord.conf"), "status"], str(root)),
                ],
            )

    def test_supervisor_status_requires_both_owned_programs_running(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            run_dir = root / "run"
            services = root / "services"
            run_dir.mkdir(parents=True)
            services.mkdir(parents=True)
            (run_dir / "supervisord.pid").write_text("123\n", encoding="ascii")
            (services / "supervisord.conf").write_text("fixture", encoding="ascii")

            def run(_arguments, **_kwargs):
                return type(
                    "Result",
                    (),
                    {"stdout": "resume-embedding RUNNING pid 1\nresume-ocr FATAL exited\n"},
                )()

            controller = deployment.SupervisorController(
                root,
                run=run,
                process_is_owned=lambda _pid, _config: True,
            )

            with self.assertRaisesRegex(deployment.DeploymentError, "both owned workers"):
                controller.status()

    def test_persisted_supervisor_transition_on_canonical_root_does_not_reprobe(self) -> None:
        deployment = load_deployment()
        probes = []
        metadata = deployment.ControllerMetadata(str(CANONICAL_ROOT), "supervisor")

        selected = deployment.select_controller(
            CANONICAL_ROOT,
            metadata,
            lambda: probes.append("systemd") or True,
        )

        self.assertEqual(selected, "supervisor")
        self.assertEqual(probes, [])

    def test_supervisor_stale_owned_socket_and_pid_are_cleaned(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            run_dir = root / "run"
            run_dir.mkdir(parents=True)
            pid_path = run_dir / "supervisord.pid"
            socket_path = run_dir / "supervisor.sock"
            pid_path.write_text("999999\n", encoding="ascii")

            listener = None
            try:
                listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                listener.bind(str(socket_path))
            except (AttributeError, OSError):
                socket_path.write_text("stale", encoding="ascii")
            finally:
                if listener is not None:
                    listener.close()

            deployment.cleanup_stale_supervisor_state(
                root,
                process_is_owned=lambda _pid, _config: False,
            )

            self.assertFalse(pid_path.exists())
            self.assertFalse(socket_path.exists())

    def test_live_owned_supervisor_state_is_never_deleted(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            run_dir = root / "run"
            run_dir.mkdir(parents=True)
            pid_path = run_dir / "supervisord.pid"
            pid_path.write_text("123\n", encoding="ascii")

            with self.assertRaisesRegex(deployment.DeploymentError, "still running"):
                deployment.cleanup_stale_supervisor_state(
                    root,
                    process_is_owned=lambda _pid, _config: True,
                )

            self.assertTrue(pid_path.exists())

    @unittest.skipIf(os.name == "nt", "Unix socket connection semantics require Linux")
    def test_live_supervisor_socket_without_pid_is_preserved(self) -> None:
        deployment = load_deployment()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resume-ai"
            run_dir = root / "run"
            run_dir.mkdir(parents=True)
            socket_path = run_dir / "supervisor.sock"
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(socket_path))
            listener.listen(1)
            try:
                with self.assertRaisesRegex(deployment.DeploymentError, "socket is still live"):
                    deployment.cleanup_stale_supervisor_state(root)
                self.assertTrue(socket_path.exists())
            finally:
                listener.close()

    def test_root_safety_rejects_supervisor_unsafe_paths(self) -> None:
        deployment = load_deployment()
        unsafe = (
            "/tmp/with space/resume-ai",
            "/tmp/with%percent/resume-ai",
            "/tmp/-leading/resume-ai",
            "/tmp/control\nchar/resume-ai",
            "/tmp/../escape",
            "relative/path",
            "/",
        )
        for value in unsafe:
            with self.subTest(root=value):
                with self.assertRaises(deployment.DeploymentError):
                    deployment.validate_root_path(Path(value))

    def test_systemd_units_set_canonical_working_directory(self) -> None:
        for name in ("resume-embedding.service", "resume-ocr.service"):
            text = (REMOTE_DIR / "systemd" / name).read_text(encoding="utf-8")
            self.assertIn("WorkingDirectory=/home/heqing/resume-ai", text)

    def test_rollback_command_and_runbook_use_validated_helper(self) -> None:
        rollback = REMOTE_DIR / "bin" / "rollback.sh"
        self.assertTrue(rollback.is_file())
        self.assertIn("deployment.py", rollback.read_text(encoding="utf-8"))

        runbook = (REMOTE_DIR.parents[1] / "docs" / "deployment" / "remote-gpu.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("rollback.sh", runbook)
        self.assertNotIn("ln -s \"releases/$release_id\"", runbook)


if __name__ == "__main__":
    unittest.main()
