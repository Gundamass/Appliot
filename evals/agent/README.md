# Agent Evaluation Gate

This directory contains versioned, synthetic evaluation cases for the LangGraph runtime. JSONL rows contain fixture IDs, hashes, labels, bounded evidence IDs, and measured counts. They do not contain resume text, ATS HTML, prompts, DOM fragments, contact data, or form values.

Run the release gate from the repository root:

```text
pnpm eval:agent
```

The command calculates a SHA-256 over the suite files and writes an immutable `report.json` and `report.md` under `docs/superpowers/evaluations/<dataset-hash>/`. It records explicit numerators and denominators, confidence intervals, graph and adapter versions, retrieval fallback counts, LangSmith delivery counters, OCR runtime, and the automatic-submit safety result.

The PyTorch OCR result is the baseline. A MindSpore Lite result is comparable only when it uses the same `ocr-parity.jsonl` corpus and a reviewed runtime manifest. A positive parity regression means the candidate is better than the baseline; it is not a deployment approval by itself.
