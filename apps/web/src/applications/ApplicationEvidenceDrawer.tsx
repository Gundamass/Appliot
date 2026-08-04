import type { ApplicationContentReview } from "@resume/contracts";
import { EvidenceDrawer } from "../profile/EvidenceDrawer.js";

interface ApplicationEvidenceDrawerProps {
  review: ApplicationContentReview;
  returnFocusTo: HTMLElement | null;
  onClose(): void;
}

export function ApplicationEvidenceDrawer({ review, returnFocusTo, onClose }: ApplicationEvidenceDrawerProps) {
  return (
    <EvidenceDrawer
      fieldLabel={review.fieldLabel}
      value={review.draft}
      evidence={review.evidence}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    />
  );
}
