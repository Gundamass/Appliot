import { createSnapshotJobAdapter } from "./types.js";

export const mokaJobAdapter = createSnapshotJobAdapter({
  source: "moka",
  version: "moka-job-v1",
  supportsUrl(url) {
    return url.hostname === "mokahr.com"
      || url.hostname.endsWith(".mokahr.com")
      || url.hostname === "moka.com"
      || url.hostname.endsWith(".moka.com");
  },
  filterKeys: {
    target_role: "keyword",
    location: "location",
    employment_type: "employment_type"
  }
});
