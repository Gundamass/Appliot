export { classifyAction, type ActionContext } from "./action-classifier.js";
export {
  FIELD_DEFINITIONS,
  PROFILE_SECTION_DEFINITIONS,
  fieldDefinitionText,
  profileSectionFor,
  resolveDeterministicSemantic,
  semanticLookupPaths,
  type FieldDefinition,
  type FieldSection,
  type ProfileSectionDefinition,
  type FieldSemanticMatch,
  type SemanticFieldInput,
  type SemanticFieldType
} from "./field-registry.js";
export { normalizeForm, type FormContext } from "./normalize.js";
export {
  classifyMokahrAddActions,
  isMokahrPage,
  sortMokahrEntryFields,
  type MokahrAddAction,
  type MokahrObservedAction,
  type MokahrObservedField,
  type MokahrSection
} from "./mokahr-adapter.js";
export {
  collectRawFormObservation,
  type RawFormField,
  type RawFormObservation,
  type RawPageAction
} from "./snapshot-script.js";
