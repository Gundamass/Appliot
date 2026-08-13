# 档案同步与系统回归报告

日期：2026-08-13

## 实现结果

- 候选人档案每次有效修改都会推进持久化 revision；投递任务记录已应用版本、同步中、同步成功和同步失败状态。
- 自动档案刷新仅处理正在等待资料的任务，以及当前进程内仍在观察页面的活跃任务。历史失败任务不会因保存档案被隐式复活。
- 用户可以对失败任务显式执行 `sync_profile`；系统重新观察真实页面、只处理空字段，并在最终审核页锁定，不生成提交命令。
- 前端以中文展示同步状态和可操作失败原因，不直接暴露内部英文错误码。

## 验证结果

```text
pnpm test: passed
API: 374 passed
Web: 164 passed
Browser Worker: 67 passed
pnpm typecheck: passed
pnpm build: passed
pnpm audit --prod --audit-level high: no known vulnerabilities
pnpm test:e2e: 18/18 passed
git diff --check: passed
```

浏览器 E2E 覆盖 DJI 风格字段、Mokahr 重复经历和 PDF 上传、档案补全后重新匹配、浏览器暂停恢复，以及终态提交拒绝。真实本地任务页面在 `1280x800` 和 `390x844` 视口下没有横向溢出、越界元素或提交控件。

## 剩余边界

- 本轮没有重新取得外部 DJI 官网的登录会话，因此未把合成 `dji-coverage` 用例描述为真实官网验收。
- 按用户决定，本地档案/PDF/头像静态加密及敏感资料发送到 DeepSeek/向量服务的治理暂不实现。
