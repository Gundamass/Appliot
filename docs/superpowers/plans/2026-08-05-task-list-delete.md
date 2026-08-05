# 投递任务列表删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在投递审核列表直接删除任务，活动任务先取消受控浏览器流程再删除记录。

**Architecture:** 复用现有 `ApplicationApi.command` 和 `ApplicationApi.delete`。`ProfileApplicationWorkspace` 负责删除流程和列表状态，`ApplicationReviewInbox` 只负责卡片展示、确认和回调触发，保持展示组件与 API 解耦。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、lucide-react。

## Global Constraints

- 所有删除操作必须经过用户确认。
- 活动任务必须先取消，再调用删除接口；取消失败时不得继续删除。
- 终态任务不调用取消接口。
- 不触碰招聘网站提交逻辑，不增加自动提交能力。
- 手工编辑使用 `apply_patch`，验证使用仓库现有 pnpm/Vitest 命令。

---

### Task 1: 扩展任务列表卡片删除交互

**Files:**
- Modify: `apps/web/src/applications/ApplicationReviewInbox.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/applications/ApplicationReviewInbox.test.tsx`

**Interfaces:**
- Consumes: `ApplicationReviewInboxProps.onDeleteTask(task: ApplicationTask): void | Promise<void>` and optional `deletingTaskId`。
- Produces: 每张审核任务卡片上的可访问“删除任务”按钮；用户取消确认时不触发回调。

- [ ] **Step 1: Write the failing tests**

在 `ApplicationReviewInbox.test.tsx` 增加以下行为测试：

```tsx
it("shows a delete action on every review task", () => {
  render(<ApplicationReviewInbox tasks={[task("1", "needs_questions", "questions")]} onOpenTask={vi.fn()} onDeleteTask={vi.fn()} />);
  expect(screen.getByRole("button", { name: "删除任务" })).toBeVisible();
});

it("does not delete when the user cancels confirmation", async () => {
  const user = userEvent.setup();
  const onDeleteTask = vi.fn();
  vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<ApplicationReviewInbox tasks={[task("1", "failed", "failed")]} onOpenTask={vi.fn()} onDeleteTask={onDeleteTask} />);
  await user.click(screen.getByRole("button", { name: "删除任务" }));
  expect(onDeleteTask).not.toHaveBeenCalled();
});

it("passes the confirmed task to the delete callback", async () => {
  const user = userEvent.setup();
  const onDeleteTask = vi.fn();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const candidate = task("1", "needs_questions", "questions");
  render(<ApplicationReviewInbox tasks={[candidate]} onOpenTask={vi.fn()} onDeleteTask={onDeleteTask} />);
  await user.click(screen.getByRole("button", { name: "删除任务" }));
  expect(onDeleteTask).toHaveBeenCalledWith(candidate);
});
```

在测试清理中恢复 `window.confirm`，避免测试之间共享 mock。

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk pnpm exec vitest run apps/web/src/applications/ApplicationReviewInbox.test.tsx`

Expected: FAIL，因为组件尚未接受 `onDeleteTask`，也没有“删除任务”按钮。

- [ ] **Step 3: Write the minimal implementation**

在 props 中加入 `onDeleteTask`，在卡片操作区保留“进入任务”，新增使用 `Trash2` 的图标按钮：

```tsx
<button
  className="icon-button danger"
  type="button"
  aria-label="删除任务"
  title="删除任务"
  onClick={() => {
    const message = task.commands.includes("cancel")
      ? "该任务仍在受控浏览器中运行，删除前会先取消任务。确定删除吗？"
      : "确定删除这条投递任务记录吗？";
    if (window.confirm(message)) void onDeleteTask(task);
  }}
>
  <Trash2 aria-hidden="true" size={16} />
</button>
```

使用现有 `icon-button` 样式体系，在 `styles.css` 添加 `.review-task-actions` 的布局和 `.review-task .icon-button.danger` 的危险色、固定尺寸与焦点样式，移动端保持操作区不溢出卡片。

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk pnpm exec vitest run apps/web/src/applications/ApplicationReviewInbox.test.tsx`

Expected: PASS，包含原有进入任务测试。

- [ ] **Step 5: Commit**

```bash
rtk git add apps/web/src/applications/ApplicationReviewInbox.tsx apps/web/src/applications/ApplicationReviewInbox.test.tsx
rtk git commit -m "feat: add task deletion action to review inbox"
```

### Task 2: 编排取消后删除并刷新列表

**Files:**
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.tsx`
- Test: `apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx`

**Interfaces:**
- Consumes: `ApplicationReviewInbox.onDeleteTask(task)` from Task 1; `ApplicationApi.command` and `ApplicationApi.delete`.
- Produces: 活动任务按“取消 -> 删除”顺序执行；终态任务直接删除；成功后列表移除；失败保留任务并显示错误。

- [ ] **Step 1: Write the failing tests**

在现有 `ProfileApplicationWorkspace.test.tsx` 中导入 `ApplicationApi` 和 `ApplicationTask` 类型，将测试用的 `applicationApi` 改成工厂函数，并增加 `delete: vi.fn()`；为 workspace 删除处理器增加测试，使用 `calls: string[]` 记录调用顺序：

```tsx
function applicationApiFor(tasks: ApplicationTask[], calls: string[], options: { commandResult?: ApplicationTask } = {}): ApplicationApi {
  return {
    list: vi.fn().mockResolvedValue(tasks),
    create: vi.fn(),
    get: vi.fn(),
    command: vi.fn(async () => {
      calls.push("cancel");
      return options.commandResult ?? tasks[0]!;
    }),
    delete: vi.fn(async () => { calls.push("delete"); }),
    recover: vi.fn()
  };
}
```

测试使用已有 `task` 工厂补充 `commands: ["cancel"]` 的 `needs_questions` 任务和 `commands: []` 的 `failed` 任务，并将 `window.confirm` mock 为 `true`。

```tsx
it("cancels an active task before deleting it", async () => {
  const calls: string[] = [];
  const api = applicationApiFor([activeTask], calls, { commandResult: cancelledTask });
  render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={api} /></BrowserRouter>);
  await userEvent.setup().click(screen.getByRole("button", { name: "删除任务" }));
  expect(calls).toEqual(["cancel", "delete"]);
  expect(screen.queryByText(activeTask.applicationUrl)).not.toBeInTheDocument();
});

it("deletes a terminal task without cancelling it", async () => {
  const calls: string[] = [];
  const api = applicationApiFor([failedTask], calls);
  render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={api} /></BrowserRouter>);
  await userEvent.setup().click(screen.getByRole("button", { name: "删除任务" }));
  expect(calls).toEqual(["delete"]);
});
```

补充取消失败和删除失败测试：任务仍显示，并出现 `role="alert"` 的中文错误提示。

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk pnpm exec vitest run apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx`

Expected: FAIL，因为 workspace 尚未把删除回调传入审核列表，也没有取消/删除编排。

- [ ] **Step 3: Write the minimal implementation**

在 workspace 中增加 `deletingTaskId` 与 `tasksError` 状态，并实现：

```tsx
const deleteTask = async (task: ApplicationTask) => {
  setDeletingTaskId(task.id);
  setTasksError(undefined);
  try {
    if (task.commands.includes("cancel")) {
      await applicationApi.command(task.id, { type: "cancel" });
    }
    await applicationApi.delete?.(task.id);
    setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
  } catch {
    setTasksError("任务删除失败，请重试；任务记录仍已保留。");
  } finally {
    setDeletingTaskId(undefined);
  }
};
```

将回调传给 `ApplicationReviewInbox`，并传递 `deletingTaskId`；删除期间只禁用当前删除按钮。调用前检查 `applicationApi.delete` 是否存在，不存在时抛出“当前客户端不支持删除任务”，保留卡片并显示错误。

- [ ] **Step 4: Run focused and full web tests**

Run: `rtk pnpm exec vitest run apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx apps/web/src/applications/ApplicationReviewInbox.test.tsx`

Expected: PASS。

Run: `rtk pnpm test -- --run`

Expected: Web and shared tests pass without regressions.

- [ ] **Step 5: Verify the built frontend**

Run: `rtk pnpm --filter @resume/web build`

Expected: Vite production build completes successfully.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/web/src/workspace/ProfileApplicationWorkspace.tsx apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx apps/web/src/applications/ApplicationReviewInbox.tsx apps/web/src/applications/ApplicationReviewInbox.test.tsx
rtk git commit -m "feat: delete application tasks from review list"
```
