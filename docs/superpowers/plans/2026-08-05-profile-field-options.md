# 候选人档案字段选项实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正候选人档案枚举控件，将性别、民族、政治面貌等字段显示为真实选项，并为地址字段提供可输入的城市建议。

**Architecture:** 在 `@resume/form-semantics` 的 `FieldDefinition` 中增加档案控件元数据和集中选项常量，继续保留招聘页面使用的 `types` 字段。Web 端新增共享 `ProfileFieldControl`，由标量字段和重复经历编辑器共同使用；控件根据显式 `profileControl` 渲染，禁止再通过 `radio` 类型猜测布尔语义。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Lucide React、原生 `select` 与 `datalist`。

## Global Constraints

- 只有真实布尔语义字段使用“是/否”。
- 枚举选项由字段语义注册表集中维护，不由模型运行时生成。
- 地址字段可输入任意文本，建议列表不能限制用户录入。
- 已有不在标准选项中的值必须作为临时选项继续显示，不能静默丢失。
- 档案保存标准值，目标招聘网站选项转换留在投递映射层。
- 所有可见文案使用中文。
- 不修改项目要点、实习描述和项目亮点的用户原文。
- 既有 `.superpowers/sdd/*` 修改不得回退、覆盖或加入提交。

---

### Task 1: 增加档案控件元数据和标准选项

**Files:**
- Modify: `packages/form-semantics/src/field-registry.ts`
- Modify: `packages/form-semantics/src/field-registry.test.ts`

**Interfaces:**
- Produces `ProfileFieldControl = "text" | "textarea" | "date" | "boolean" | "enum" | "suggestion"`.
- Extends `FieldDefinition` with `profileControl` and optional `profileOptions`.
- Exports `PROFILE_FIELD_OPTIONS` for tests and the Web shared control.

- [ ] **Step 1: Write failing registry tests**

在 `field-registry.test.ts` 增加测试，直接读取 `FIELD_DEFINITIONS`：

```ts
expect(definition("basics.gender")).toMatchObject({
  profileControl: "enum",
  profileOptions: ["男", "女", "其他", "不愿透露"]
});
expect(definition("basics.nationality")?.profileControl).toBe("suggestion");
expect(definition("basics.ethnicity")?.profileOptions).toContain("汉族");
expect(definition("basics.politicalStatus")?.profileOptions).toContain("中共党员");
expect(definition("basics.maritalStatus")?.profileOptions).toContain("未婚");
expect(definition("preferences.willingToTravel")?.profileControl).toBe("boolean");
expect(definition("education[].degree")?.profileOptions).toContain("硕士");
```

测试辅助函数通过 `FIELD_DEFINITIONS.find((field) => field.semantic === semantic)` 获取定义，并断言民族选项包含完整 56 项。

- [ ] **Step 2: Run the registry tests and verify RED**

Run:

```powershell
rtk pnpm --filter @resume/form-semantics exec vitest run src/field-registry.test.ts
```

Expected: FAIL，因为 `profileControl`、`profileOptions` 和标准选项尚未存在。

- [ ] **Step 3: Implement explicit field metadata**

在 `field-registry.ts` 增加：

```ts
export type ProfileFieldControl = "text" | "textarea" | "date" | "boolean" | "enum" | "suggestion";

export interface FieldDefinition {
  // existing fields...
  profileControl: ProfileFieldControl;
  profileOptions?: readonly string[];
}
```

集中定义以下选项：性别 4 项、民族 56 项、政治面貌 7 项、婚姻状况 6 项、证件类型 5 项、学历 6 项、学历类型 3 项、培养类别 5 项、工作性质/用工类型 5 项、奖项级别 6 项，以及地址建议列表。

为 `definition` 和 `repeated` 工厂增加显式控件参数，并为相关字段设置：

- `gender`、`nationality`、`ethnicity`、`politicalStatus`、`maritalStatus`、`identity.idType`、学历、培养类别、用工类型和奖项级别使用 `enum` 或 `suggestion`。
- `willingToRelocate`、`willingToTravel`、`education[].isHighest` 使用 `boolean`。
- 出生日期、经历日期使用 `date`；多行描述使用 `textarea`；其余字段使用 `text`。

不得从 `types.includes("radio")` 推导档案控件类型。

- [ ] **Step 4: Run the registry tests and verify GREEN**

Run：

```powershell
rtk pnpm --filter @resume/form-semantics exec vitest run src/field-registry.test.ts
rtk pnpm --filter @resume/form-semantics typecheck
```

Expected: 测试和类型检查通过。

- [ ] **Step 5: Commit the registry contract**

```powershell
rtk git add packages/form-semantics/src/field-registry.ts packages/form-semantics/src/field-registry.test.ts
rtk git commit -m "feat: define profile field option metadata"
```

### Task 2: 建立共享档案字段控件

**Files:**
- Create: `apps/web/src/profile/ProfileFieldControl.tsx`
- Create: `apps/web/src/profile/ProfileFieldControl.test.tsx`
- Modify: `apps/web/src/profile/CandidateProfileCenter.tsx`
- Modify: `apps/web/src/profile/RepeatedEntryEditor.tsx`

**Interfaces:**
- `ProfileFieldControl({ field, value, disabled, missing, onChange, onControl })` renders one controlled field.
- `onControl` receives the native input/select/textarea element or `null` for focus management.
- The component materializes repeated entry paths outside itself; it only renders the supplied `FieldDefinition`.

- [ ] **Step 1: Write failing shared-control tests**

覆盖以下行为：

```tsx
render(<ProfileFieldControl field={gender} value="" disabled={false} missing onChange={vi.fn()} onControl={vi.fn()} />);
expect(screen.getByRole("combobox")).toHaveValue("");
expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["请选择", "男", "女", "其他", "不愿透露"]);
expect(screen.queryByRole("option", { name: "是" })).not.toBeInTheDocument();
```

另测布尔字段只显示“是、否”；地址 suggestion 字段渲染 `input[list]` 和 `datalist`，且可以输入不在建议列表中的值；已有非标准枚举值会作为临时 option 保留。

- [ ] **Step 2: Run the shared-control tests and verify RED**

Run：

```powershell
rtk pnpm --filter @resume/web exec vitest run src/profile/ProfileFieldControl.test.tsx
```

Expected: FAIL，因为共享控件尚不存在。

- [ ] **Step 3: Implement the shared control**

控件渲染规则固定为：

- `boolean`：原生 `select`，选项为空、是、否。
- `enum`：原生 `select`，选项为空、标准选项；当前旧值不在标准列表时追加当前值。
- `suggestion`：文本 `input` 加 `datalist`，允许自由输入；当前值不受建议列表限制。
- `date`：`input type="date"`。
- `textarea`：`textarea`。
- `text`：普通文本 `input`。

所有原生控件必须保留 `aria-label={field.label}`、`ref={onControl}`、受控 `value` 和 `onChange`。缺失提示继续由父组件传入，项目描述、项目要点和职责成果不增加任何生成按钮。

- [ ] **Step 4: Replace duplicated control logic**

删除 `CandidateProfileCenter.tsx` 的本地 `ScalarField` 控件分支和 `RepeatedEntryEditor.tsx` 的本地 `ProfileControl` 分支，改为传入共享控件。重复条目的 `path` 仍由编辑器计算，并将路径回调传入父组件，保持现有“补全资料”聚焦行为。

- [ ] **Step 5: Run Web focused tests and verify GREEN**

Run：

```powershell
rtk pnpm --filter @resume/web exec vitest run src/profile/ProfileFieldControl.test.tsx src/profile/CandidateProfileCenter.test.tsx src/profile/RepeatedEntryEditor.test.tsx
rtk pnpm --filter @resume/web typecheck
```

Expected: 共享控件、重复条目、草稿保存和缺失字段聚焦测试全部通过。

- [ ] **Step 6: Commit the shared control**

```powershell
rtk git add apps/web/src/profile/ProfileFieldControl.tsx apps/web/src/profile/ProfileFieldControl.test.tsx apps/web/src/profile/CandidateProfileCenter.tsx apps/web/src/profile/RepeatedEntryEditor.tsx
rtk git commit -m "feat: render profile fields with semantic controls"
```

### Task 3: 完成档案回归和真实页面验证

**Files:**
- Modify: `apps/web/src/profile/CandidateProfileCenter.test.tsx`
- Modify: `apps/web/src/profile/ProfilePage.test.tsx`
- Modify: `apps/web/src/profile/ProfileFieldControl.test.tsx`
- Modify: `tests/browser/profile-workspace.spec.ts`

- [ ] **Step 1: Add regression assertions**

在档案中心测试中断言：

- 性别、国籍、民族、政治面貌、婚姻状况不再显示“是/否”。
- 是否接受出差、是否接受异地工作仍显示“是/否”。
- 现居住地和户籍所在地允许输入自定义城市。
- 学历、用工类型、奖项级别使用各自标准选项。
- 已有非标准值仍可见，保存时不被清空。

在浏览器测试中注入包含这些字段的资料响应，验证 1280px 和 390px 页面无横向溢出，并截图保存档案中心初始状态。

- [ ] **Step 2: Run focused tests and verify RED where needed**

Run：

```powershell
rtk pnpm --filter @resume/web exec vitest run src/profile/CandidateProfileCenter.test.tsx src/profile/ProfilePage.test.tsx src/profile/ProfileFieldControl.test.tsx
rtk pnpm exec playwright test tests/browser/profile-workspace.spec.ts
```

Expected: 新增断言在实现不完整时失败；完成 Task 2 后全部通过。

- [ ] **Step 3: Run the complete verification gate**

```powershell
rtk pnpm --filter @resume/web test
rtk pnpm --filter @resume/web typecheck
rtk pnpm --filter @resume/web build
rtk pnpm test:e2e
rtk git diff --check
```

Expected: 全部以 `0` 退出，浏览器测试不触发任何招聘网站最终提交。

- [ ] **Step 4: Commit the regression coverage**

```powershell
rtk git add apps/web/src/profile/CandidateProfileCenter.test.tsx apps/web/src/profile/ProfilePage.test.tsx apps/web/src/profile/ProfileFieldControl.test.tsx tests/browser/profile-workspace.spec.ts
rtk git commit -m "test: cover profile field option controls"
```

## Final Review Checklist

- 枚举字段不会再显示为“是/否”。
- 只有真实布尔字段使用“是/否”。
- 地址字段支持自由输入和建议值。
- 非标准旧值不会丢失。
- 重复经历字段继续保持分组和统一保存。
- 投递映射仍依据目标页面真实选项，不猜测填写。
- 所有测试和构建通过。
