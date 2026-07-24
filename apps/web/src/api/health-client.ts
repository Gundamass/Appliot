import { AdapterHealthResponseSchema, ErrorResponseSchema, type AdapterStatus } from "@resume/contracts";

export interface HealthApi {
  getStatuses(): Promise<AdapterStatus[]>;
}

export function createHealthApi(baseUrl = ""): HealthApi {
  return {
    async getStatuses() {
      const response = await fetch(`${baseUrl}/api/health/adapters`, { method: "GET" });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const error = ErrorResponseSchema.safeParse(payload);
        throw new Error(error.success ? error.data.error : `Health request failed (${response.status})`);
      }
      return AdapterHealthResponseSchema.parse(payload);
    }
  };
}
