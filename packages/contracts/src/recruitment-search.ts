import { z } from "zod";

export const RecruitmentSearchTypeSchema = z.enum(["campus", "social", "internship", "unknown"]);
export const RecruitmentCompanySchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "recruitment_company_control_character");

const HttpsUrlSchema = z.string().url().max(2_048).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "recruitment_url_must_be_https");

export const RecruitmentSearchRequestSchema = z.object({
  companyName: RecruitmentCompanySchema,
  recruitmentType: RecruitmentSearchTypeSchema
}).strict();

export const RecruitmentSiteCandidateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  url: HttpsUrlSchema,
  domain: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9.-]+$/u),
  snippet: z.string().trim().max(500),
  source: z.literal("tavily"),
  sourceScore: z.number().min(0).max(1).optional()
}).strict();

export const RecruitmentSiteSearchResultSchema = z.object({
  query: z.string().trim().min(1).max(200),
  candidates: z.array(RecruitmentSiteCandidateSchema).max(3)
}).strict();

export const VerifiedRecruitmentSiteSchema = z.object({
  company: RecruitmentCompanySchema,
  recruitmentType: RecruitmentSearchTypeSchema,
  query: z.string().trim().min(1).max(200),
  ...RecruitmentSiteCandidateSchema.shape
}).strict();

export type RecruitmentSearchRequest = z.infer<typeof RecruitmentSearchRequestSchema>;
export type RecruitmentSearchType = z.infer<typeof RecruitmentSearchTypeSchema>;
export type RecruitmentSiteCandidate = z.infer<typeof RecruitmentSiteCandidateSchema>;
export type RecruitmentSiteSearchResult = z.infer<typeof RecruitmentSiteSearchResultSchema>;
export type VerifiedRecruitmentSite = z.infer<typeof VerifiedRecruitmentSiteSchema>;

export interface RecruitmentSiteSearchPort {
  search(input: RecruitmentSearchRequest): Promise<RecruitmentSiteSearchResult>;
}
