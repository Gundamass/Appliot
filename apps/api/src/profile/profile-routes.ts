import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EvidenceSchema, JsonValueSchema, ProfileFactSchema } from "@resume/contracts";
import {
  DuplicateDocumentError,
  InvalidPdfError,
  ProfileImportUnavailableError,
  importProfileDocument,
  type ProfileImportDependencies
} from "./import-service.js";
import type { ProfileRepository } from "./profile-repository.js";

const FactIdParamsSchema = z.object({ id: z.string().min(1).max(128) });
const CorrectionBodySchema = z.object({
  value: JsonValueSchema,
  evidence: z.array(EvidenceSchema).min(1).max(20)
});
const DocumentResponseSchema = z.object({ documentId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
const ErrorResponseSchema = z.object({ error: z.string().min(1) });
const UploadMetadataSchema = z.object({
  fieldname: z.literal("file"),
  filename: z.string().min(1).max(255),
  mimetype: z.literal("application/pdf")
});

export interface ProfileRouteDependencies extends ProfileImportDependencies {
  profileRepository: ProfileRepository;
}

export function registerProfileRoutes(app: FastifyInstance, dependencies: ProfileRouteDependencies): void {
  app.post("/api/documents", async (request, reply) => {
    if (!request.isMultipart()) return reply.code(400).send(errorResponse("Invalid request"));

    try {
      const file = await request.file();
      if (!file) return reply.code(400).send(errorResponse("Invalid PDF upload"));
      const metadata = UploadMetadataSchema.safeParse(file);
      if (!metadata.success) {
        return reply.code(400).send(errorResponse("Invalid PDF upload"));
      }
      const bytes = await file.toBuffer();
      if (!hasPdfSignature(bytes)) return reply.code(400).send(errorResponse("Invalid PDF upload"));

      const imported = DocumentResponseSchema.parse(await importProfileDocument(dependencies, metadata.data.filename, bytes));
      return reply.code(202).send(imported);
    } catch (error) {
      if (error instanceof DuplicateDocumentError) return reply.code(409).send(errorResponse("Document already imported"));
      if (error instanceof InvalidPdfError) return reply.code(400).send(errorResponse("Invalid PDF upload"));
      if (error instanceof ProfileImportUnavailableError) {
        return reply.code(503).send(errorResponse("Profile import is temporarily unavailable"));
      }
      if (isMultipartError(error)) return reply.code(400).send(errorResponse("Invalid request"));
      return reply.code(400).send(errorResponse("Invalid request"));
    }
  });

  app.get("/api/profile/facts", async (_request, reply) => {
    return reply.code(200).send(z.array(ProfileFactSchema).parse(dependencies.profileRepository.listActive()));
  });

  app.post("/api/profile/facts/:id/confirm", async (request, reply) => {
    const params = FactIdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorResponse("Invalid request"));
    try {
      return reply.code(200).send(ProfileFactSchema.parse(dependencies.profileRepository.confirm(params.data.id)));
    } catch (error) {
      return profileFactError(error, reply);
    }
  });

  app.post("/api/profile/facts/:id/correct", async (request, reply) => {
    const params = FactIdParamsSchema.safeParse(request.params);
    const body = CorrectionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(errorResponse("Invalid request"));
    try {
      return reply.code(200).send(ProfileFactSchema.parse(
        dependencies.profileRepository.correct(params.data.id, body.data.value, body.data.evidence)
      ));
    } catch (error) {
      return profileFactError(error, reply);
    }
  });
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  const header = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024))).toString("latin1");
  return header.includes("%PDF-");
}

function isMultipartError(error: unknown): boolean {
  return error instanceof Error && /multipart|file.*large|limit/i.test(error.message);
}

function profileFactError(error: unknown, reply: { code(statusCode: number): { send(payload: unknown): unknown } }): unknown {
  if (error instanceof Error && error.message.startsWith("profile fact not found:")) {
    return reply.code(404).send(errorResponse("Profile fact not found"));
  }
  return reply.code(400).send(errorResponse("Invalid request"));
}

function errorResponse(error: string): z.infer<typeof ErrorResponseSchema> {
  return ErrorResponseSchema.parse({ error });
}
