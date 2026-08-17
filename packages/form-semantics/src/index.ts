export { classifyAction, type ActionContext } from "./action-classifier.js";
export {
  FIELD_DEFINITIONS,
  PROFILE_SECTION_DEFINITIONS,
  fieldDefinitionText,
  isAllowedExtractedFieldPath,
  listExtractableFieldPathTemplates,
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
  BUILT_IN_HINT_PACKS,
  createHintPackRegistry,
  fingerprintSnapshot,
  type HintPackRegistry,
  type HintPackResolution
} from "./hint-packs/registry.js";
export { applyCertifiedHintPack, classifyRepeatedActions } from "./hint-packs/runtime.js";
export { certifiedTextReference } from "./hint-packs/text-reference.js";
export { djiHintPack, DJI_FIELD_RULES } from "./hint-packs/dji-pack.js";
export { mokahrHintPack, MOKAHR_ACTION_RULES, MOKAHR_SECTIONS } from "./hint-packs/mokahr-pack.js";
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
