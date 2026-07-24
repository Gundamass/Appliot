import { AdapterHealthResponseSchema, ErrorResponseSchema, type AdapterStatus } from "@resume/contracts";

export interface HealthApi {
  getStatuses(signal?: AbortSignal): Promise<AdapterStatus[]>;
}

export function createHealthApi(baseUrl = ""): HealthApi {
  return {
    async getStatuses(signal) {
      const response = await fetch(`${baseUrl}/api/health/adapters`, {
        method: "GET",
        ...(signal === undefined ? {} : { signal })
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const error = ErrorResponseSchema.safeParse(payload);
        throw new Error(error.success ? error.data.error : `Health request failed (${response.status})`);
      }
      return AdapterHealthResponseSchema.parse(payload);
    }
  };
}
