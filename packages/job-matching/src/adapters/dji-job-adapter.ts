import { createSnapshotJobAdapter } from "./types.js";
import { isUnrestrictedLocationValue } from "../expectation.js";

const DJI_CAMPUS_PORTAL_URL = "https://apply.careers.dji.com/campus-recruitment/dji/143359?locale=zh-CN#/";

export const djiJobAdapter = createSnapshotJobAdapter({
  source: "dji",
  version: "dji-job-v1",
  supportsUrl(url) {
    const isDjiCareersPage = (url.hostname === "dji.com" || url.hostname.endsWith(".dji.com"))
      && /\/careers(?:\/|$)/u.test(url.pathname);
    const isDjiApplyPortal = url.hostname === "apply.careers.dji.com"
      && /^\/(?:campus|social)-recruitment\/[^/]+\/[^/]+(?:\/|$)/u.test(url.pathname);
    return isDjiCareersPage || isDjiApplyPortal;
  },
  normalizeEntryUrl(url) {
    const isCurrentCampusLanding = (
      url.hostname === "careers.dji.com"
      || url.hostname === "we.dji.com"
    ) && /^\/zh-CN(?:\/campus(?:\/|$))?\/?$/u.test(url.pathname);
    if (isCurrentCampusLanding) return new URL(DJI_CAMPUS_PORTAL_URL);
    return undefined;
  },
  filterKeys: {
    target_role: "keyword",
    location: "work_location"
  },
  localOnlyReason(criterion) {
    if (criterion.kind === "location" && criterion.values.some(isUnrestrictedLocationValue)) {
      return "unrestricted_location";
    }
    return undefined;
  }
});
