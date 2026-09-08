# Direct Application URL Routing Design

## Problem

The conversation router currently treats any single HTTPS URL as a manually supplied recruitment-site URL whenever `lastRecruitmentRequest` exists. That stale context takes precedence over the user's current wording, so an explicit request such as `填写 https://jobs.example.com/apply/123` is sent into recruitment-site discovery and job recommendation instead of controlled form filling.

The current conversation contract also models `start_application` only as a recommendation target. It cannot safely carry a user-provided application URL through the existing confirmation boundary.

## Confirmed behavior

- Explicit filling language plus one HTTPS URL, such as `填写 <url>`, `填表 <url>`, or `打开这个申请页面填写 <url>`, starts the controlled-application flow.
- Explicit recommendation or recruitment-site language plus one HTTPS URL continues to use recruitment-site verification and job matching.
- A bare URL is ambiguous. The assistant asks whether the user wants to fill the application page or use it for job recommendations; it performs neither side effect.
- Historical `lastRecruitmentRequest` context must never override explicit filling language.
- Creating and starting a filling task remains confirmation-gated. No form submission is performed automatically.

## Design

### Intent and target contract

Add `application_url` to `ConversationTargetKindSchema`. An application URL target contains a single bounded HTTPS `url`; recruitment-only fields remain forbidden. `start_application` accepts either the existing recommendation target or the new application URL target.

Extend the `start_application` confirmation target union to include `{ kind: "application_url", url }`. The same action name is retained so the existing confirmation transport and safety boundary remain stable.

### Deterministic precedence

Classify URL-bearing messages in this order:

1. Explicit filling language + one HTTPS URL -> `start_application`, target `application_url`, confirmation required.
2. Explicit recruitment/recommendation language -> existing recruitment flow.
3. Bare single HTTPS URL -> `unknown` with a purpose clarification response.
4. Only after those checks may a URL be interpreted from historical recruitment context, and only when the current message itself identifies it as a recruitment entry.

The runtime intent-understanding extraction also recognizes `填写`, `填表`, and equivalent form-filling terms as application intent so both routing layers agree.

### Safety and execution

Before presenting the confirmation, validate the URL with the existing public-HTTPS guard. On approval, invoke the allowlisted application-task tool with the validated URL. The tool creates an idempotent Runtime-owned task, starts the controlled application service, and returns the existing application task card.

The task identifier is deterministic from conversation ID and normalized URL. Repeated confirmation for the same conversation and URL returns the same task instead of creating duplicates.

### User interface

For an application URL confirmation, display:

- title: `准备开始识别并填写`
- target: the application URL
- approve: `确认开始填写`
- decline: `暂不填写`

After approval, the existing application task card opens the filling workspace.

## Testing

- Contract tests accept bounded HTTPS application URL targets and reject HTTP, malformed, or cross-action targets.
- Conversation graph tests reproduce stale `lastRecruitmentRequest` plus `填写 <url>` and assert no recruitment search or job-match creation occurs.
- Graph tests verify a bare URL only asks for purpose and causes no side effect.
- Tool tests verify direct URL task creation, idempotency, controlled service start, and returned card.
- Web component tests verify the application URL confirmation copy and callback.
- Focused API/web tests and workspace typecheck provide regression coverage.
