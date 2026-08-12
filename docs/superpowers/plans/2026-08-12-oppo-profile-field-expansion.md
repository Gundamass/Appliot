# 候选人档案精简字段扩展实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 OPPO 类国内 ATS 的通用候选人字段，增加选填项目链接，并按开始时间倒序展示符合指定布局的项目卡片。

**Architecture:** 继续以 `@resume/form-semantics` 的字段注册表作为档案表单与投递映射的单一语义来源。重复经历编辑器负责栏目内字段顺序、项目展示排序和布局元数据；持久化路径与原索引保持不变。PDF 结构化抽取仅允许输出注册表中的标准路径，并继续执行原文证据验证。

**Tech Stack:** TypeScript、React 19、Vitest、Testing Library、Fastify、Zod、Playwright、CSS Grid。

## Global Constraints

- 仅新增 `basics.avatar`、7 个教育字段、`work[].department` 和选填 `projects[].url`。
- 不新增意向面试地点、招聘信息获取来源、推荐码和 OPPO 亲属信息。
- 项目字段顺序固定为名称、角色、开始时间、结束时间、技术栈、链接、描述、要点。
- 项目按开始时间倒序；开始时间相同按结束时间倒序；无有效开始时间的项目稳定排在最后。
- 项目展示排序不得重写 `projects[index]` 持久化路径。
- 项目链接为空不影响保存和档案完整度。
- 头像不得把本机绝对路径发送给模型。
- 不修改或提交现有 `.superpowers/sdd/*` 用户改动和 `.runtime/`。

---

### Task 1: 扩展标准字段语义和 PDF 抽取白名单

**Files:**
- Modify: `packages/form-semantics/src/field-registry.test.ts`
- Modify: `packages/form-semantics/src/field-registry.ts`
- Modify: `packages/profile-domain/src/extraction/extract-facts.test.ts`
- Modify: `packages/profile-domain/src/extraction/extract-facts.ts`

**Interfaces:**
- Consumes: `FieldDefinition`、`resolveDeterministicSemantic(input)`、`EXTRACTION_RULES`。
- Produces: 新字段的 `FIELD_DEFINITIONS` 条目和可被结构化模型使用的标准抽取路径。

- [ ] **Step 1: 写字段注册表失败测试**

在 `field-registry.test.ts` 断言头像为文件控件，教育布尔字段为“是/否”，其余新增字段为文本或建议控件，并验证“任职部门”“项目链接”等别名能结合重复经历上下文映射到正确索引。

- [ ] **Step 2: 运行字段注册表测试并确认按预期失败**

Run: `rtk pnpm --filter @resume/form-semantics test -- field-registry.test.ts`

Expected: FAIL，新增语义尚未出现在 `FIELD_DEFINITIONS`。

- [ ] **Step 3: 最小实现新增字段定义和控件元数据**

在 `field-registry.ts` 中新增：

```ts
definition("basics.avatar", "个人头像", ["头像", "个人照片", "证件照"], ["file"], ["basics"], "候选人的个人头像", "sensitive")
repeated("education[].isExchange", "是否交流学习", ["交流学习", "是否交换学习"], ["select", "radio", "checkbox"], "education", "该教育经历是否为交流学习")
repeated("education[].isJointProgram", "是否联合办学", ["联合办学", "是否联合培养"], ["select", "radio", "checkbox"], "education", "该教育经历是否为联合办学")
repeated("education[].majorCategory", "专业类别", ["学科类别", "专业大类"], ["text", "select"], "education", "教育经历的专业类别")
repeated("education[].schoolLocation", "学校所在地", ["院校所在地"], ["text", "select"], "education", "学校所在地区")
repeated("education[].advisor", "导师姓名", ["导师", "指导教师"], ["text"], "education", "教育经历中的导师姓名")
repeated("education[].isNationalKeyLab", "是否国家重点实验室", ["国家重点实验室"], ["select", "radio", "checkbox"], "education", "所在实验室是否为国家重点实验室")
repeated("education[].laboratory", "所在实验室", ["实验室名称"], ["text"], "education", "教育经历中的实验室")
repeated("work[].department", "任职部门", ["所在部门", "所属部门"], ["text"], "work", "工作或实习所在部门")
repeated("projects[].url", "项目链接", ["项目地址", "项目网址", "代码仓库", "project url"], ["text"], "projects", "项目演示、主页或代码仓库链接")
```

并把三个教育布尔字段加入 `PROFILE_FIELD_METADATA`，控件为 `boolean`，选项为 `是/否`。为头像扩展 `ProfileFieldControl` 的 `file` 类型，后续 Task 2 实现渲染。

- [ ] **Step 4: 运行字段注册表测试并确认通过**

Run: `rtk pnpm --filter @resume/form-semantics test -- field-registry.test.ts`

Expected: PASS。

- [ ] **Step 5: 写 PDF 抽取规则失败测试**

在 `extract-facts.test.ts` 断言 `EXTRACTION_RULES` 包含新增教育、工作和项目路径，但不包含头像、本机文件路径或被排除的 OPPO 专属字段。

- [ ] **Step 6: 运行抽取测试并确认按预期失败**

Run: `rtk pnpm --filter @resume/profile-domain test -- extract-facts.test.ts`

Expected: FAIL，规则尚未覆盖新增标准路径。

- [ ] **Step 7: 更新抽取白名单**

扩展 `EXTRACTION_RULES` 的 canonical path 列表，加入新增教育字段、`work[index].department` 和 `projects[index].url`。不加入 `basics.avatar`，因为结构化文本模型不能安全产出本机文件引用。

- [ ] **Step 8: 运行抽取与字段测试**

Run: `rtk pnpm --filter @resume/profile-domain test -- extract-facts.test.ts && rtk pnpm --filter @resume/form-semantics test -- field-registry.test.ts`

Expected: 两组测试均 PASS。

### Task 2: 实现档案控件和项目稳定排序

**Files:**
- Modify: `apps/web/src/profile/ProfileFieldControl.test.tsx`
- Modify: `apps/web/src/profile/ProfileFieldControl.tsx`
- Modify: `apps/web/src/profile/RepeatedEntryEditor.test.tsx`
- Modify: `apps/web/src/profile/RepeatedEntryEditor.tsx`
- Modify: `apps/web/src/profile/CandidateProfileCenter.test.tsx`
- Modify: `apps/web/src/profile/CandidateProfileCenter.tsx`

**Interfaces:**
- Consumes: Task 1 的 `FieldDefinition.profileControl` 和新增标准路径。
- Produces: `sortRepeatedEntries(section, entries)` 的稳定项目展示顺序，以及可保存新文本/布尔字段的档案编辑器。

- [ ] **Step 1: 写项目字段顺序和排序失败测试**

在 `RepeatedEntryEditor.test.tsx` 断言项目控件顺序为：

```ts
["项目名称", "项目角色", "项目开始时间", "项目结束时间", "技术栈", "项目链接", "项目描述", "项目要点"]
```

再使用四个项目验证：新日期在前、相同开始时间按结束时间倒序、无开始时间按原索引稳定排在最后，并断言每个输入仍使用原来的 `projects[index]` 路径更新。

- [ ] **Step 2: 运行重复经历编辑器测试并确认按预期失败**

Run: `rtk pnpm --filter @resume/web test -- RepeatedEntryEditor.test.tsx`

Expected: FAIL，当前字段顺序不同且项目仅按索引排序。

- [ ] **Step 3: 最小实现稳定项目排序和字段顺序**

在 `RepeatedEntryEditor.tsx`：

```ts
const FIELD_ORDERS = {
  projects: ["name", "role", "startDate", "endDate", "technologies", "url", "description", "highlights[0]"]
};
```

增加纯函数读取 `projects[index].startDate/endDate`，接受 `YYYY-MM`、`YYYY-MM-DD`、`YYYY/MM` 和 `YYYY/MM/DD`，返回可比较的年月日键。仅当 `section === "projects"` 时使用稳定比较器，其余栏目继续按索引排列。

- [ ] **Step 4: 运行重复经历编辑器测试并确认通过**

Run: `rtk pnpm --filter @resume/web test -- RepeatedEntryEditor.test.tsx`

Expected: PASS。

- [ ] **Step 5: 写头像控件安全行为失败测试**

在 `ProfileFieldControl.test.tsx` 断言头像字段渲染文件选择控件，`accept="image/png,image/jpeg,image/webp"`，且选择文件时回调收到受控本地文件标识而不是绝对路径。若当前档案 API 只支持 JSON 标量，则测试要求控件显示“头像上传将在投递时选择”并保持不可持久化，避免伪造路径。

- [ ] **Step 6: 运行头像控件测试并确认按预期失败**

Run: `rtk pnpm --filter @resume/web test -- ProfileFieldControl.test.tsx`

Expected: FAIL，当前没有 `file` 档案控件。

- [ ] **Step 7: 实现头像控件的本地安全边界**

根据现有档案 API 能力采用最小安全实现：渲染文件输入并只保存文件名/受控资产 ID；绝不读取或保存浏览器提供的伪路径。若没有资产上传端点，则控件保持选取状态仅用于当前页面，并显示为未持久化，不能进入普通 `upsert`。

- [ ] **Step 8: 验证新增字段保存与可选链接**

在 `CandidateProfileCenter.test.tsx` 增加教育、任职部门、项目链接的编辑保存断言，并确认空项目链接不会触发 `upsert` 或缺失提示。

- [ ] **Step 9: 运行候选人档案相关测试**

Run: `rtk pnpm --filter @resume/web test -- ProfileFieldControl.test.tsx RepeatedEntryEditor.test.tsx CandidateProfileCenter.test.tsx`

Expected: PASS。

### Task 3: 实现项目专属布局

**Files:**
- Modify: `apps/web/src/profile/RepeatedEntryEditor.test.tsx`
- Modify: `apps/web/src/profile/RepeatedEntryEditor.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/styles.test.ts`

**Interfaces:**
- Consumes: Task 2 的项目字段顺序。
- Produces: 项目字段对应的 `profile-field-wide` 布局标记和响应式 CSS Grid。

- [ ] **Step 1: 写布局失败测试**

断言项目的技术栈、项目链接、项目描述和项目要点标签带有整行布局类；名称、角色、开始和结束时间保持半宽。补充样式测试断言桌面两列和移动端单列规则仍存在。

- [ ] **Step 2: 运行布局测试并确认按预期失败**

Run: `rtk pnpm --filter @resume/web test -- RepeatedEntryEditor.test.tsx styles.test.ts`

Expected: FAIL，当前只有 textarea 自动整行，技术栈和链接仍为半宽。

- [ ] **Step 3: 实现项目字段布局元数据**

在 `RepeatedEntryEditor.tsx` 使用路径叶子判断项目整行字段：

```ts
const PROJECT_WIDE_FIELDS = new Set(["technologies", "url", "description", "highlights[0]"]);
```

为对应 label 增加 `profile-field-wide`，保留现有 textarea 规则。CSS 使用已有 `.profile-form-grid` 两列和移动端单列规则，不引入嵌套卡片。

- [ ] **Step 4: 运行布局测试并确认通过**

Run: `rtk pnpm --filter @resume/web test -- RepeatedEntryEditor.test.tsx styles.test.ts`

Expected: PASS。

### Task 4: 全量验证和浏览器视觉回归

**Files:**
- Modify if needed: `tests/browser/profile-workspace.spec.ts`
- Modify if needed: `tests/browser/application-workbench-visual.spec.ts`

**Interfaces:**
- Consumes: Task 1-3 的完整行为。
- Produces: 经过类型、单元、浏览器和视觉验证的候选人档案体验。

- [ ] **Step 1: 运行受影响包单元测试**

Run: `rtk pnpm --filter @resume/form-semantics test && rtk pnpm --filter @resume/profile-domain test && rtk pnpm --filter @resume/web test`

Expected: PASS，0 个失败。

- [ ] **Step 2: 运行全仓类型检查**

Run: `rtk pnpm typecheck`

Expected: PASS，0 个 TypeScript 错误。

- [ ] **Step 3: 启动本地服务并执行候选人档案浏览器测试**

Run: `rtk playwright test tests/browser/profile-workspace.spec.ts`

Expected: PASS；项目最近时间在前，项目链接选填，指定字段布局在桌面和移动端不重叠。

- [ ] **Step 4: 浏览器截图检查**

在 `1280x900` 与 `390x844` 视口打开候选人档案项目栏目，检查字段顺序、两列/单列切换、长文本框宽度、按钮和文字无重叠。发现视觉问题则先补失败测试，再修复。

- [ ] **Step 5: 运行 Git 差异检查**

Run: `rtk git diff --check && rtk git status --short`

Expected: 无空白错误；差异中不包含 `.runtime/` 和用户已有 `.superpowers/sdd/*` 修改。

- [ ] **Step 6: 请求代码审查并处理重要问题**

以规格 `docs/superpowers/specs/2026-08-12-oppo-profile-field-expansion-design.md` 和本计划为基准，审查字段遗漏、敏感信息边界、排序稳定性、持久化索引和响应式布局。修复所有 Critical/Important 问题后重新运行 Step 1-5。
