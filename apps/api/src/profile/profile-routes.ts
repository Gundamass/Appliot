import { Busboy as BusboyConstructor, type Busboy as BusboyParser, type BusboyFileStream } from "@fastify/busboy";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentProfileDocumentSummarySchema,
  DocumentResponseSchema,
  JsonValueSchema,
  LatestProfileDocumentResponseSchema,
  ProfileCompletenessSchema,
  ProfileFactRemovalInputSchema,
  ProfileFactRemovalResultSchema,
  ProfileFactSchema,
  ProfileFactUpsertInputSchema
} from "@resume/contracts";
import { renderPdfPage as renderProfilePdfPage } from "@resume/profile-domain/src/pdf/extract-pdf.js";
import type { AvatarMimeType, AvatarStore } from "./avatar-store.js";
import { sendError } from "../http-response.js";
import {
  DuplicateDocumentError,
  InvalidPdfError,
  MAX_PDF_BYTES,
  ProfileImportUnavailableError,
  CurrentDocumentChangedError,
  DocumentImportInProgressError,
  importProfileDocument,
  parseCurrentProfileDocument,
  type ProfileImportDependencies
} from "./import-service.js";
import { retainCurrentProfileDocument } from "./current-document-service.js";
import type { ProfileRepository } from "./profile-repository.js";
import { createDocumentRepository } from "./document-repository.js";
import { findEvidenceGrounding } from "./evidence-grounding.js";
import { calculateProfileCompleteness } from "./profile-completeness.js";

const FactIdParamsSchema = z.object({ id: z.string().min(1).max(128) });
const DocumentFingerprintParamsSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
const DocumentPageParamsSchema = DocumentFingerprintParamsSchema.extend({ page: z.coerce.number().int().positive() });
const DocumentIdParamsSchema = z.object({ documentId: z.string().uuid() }).strict();
const GroundingQuerySchema = z.object({ text: z.string().min(1).max(12_000) });
const CorrectionBodySchema = z.object({
  value: JsonValueSchema
}).strict();
const ConfirmationBodySchema = z.union([z.undefined(), z.object({}).strict()]);
const UploadMetadataSchema = z.object({
  fieldname: z.literal("file"),
  filename: z.string().min(1).max(255),
  mimetype: z.literal("application/pdf")
}).strict();

class MultipartInputError extends Error {
  constructor(readonly publicMessage: "Invalid request" | "Invalid PDF upload" = "Invalid request") {
    super(publicMessage);
  }
}

export interface ProfileRouteDependencies extends ProfileImportDependencies {
  profileRepository: ProfileRepository;
  onProfileUpdated?: () => Promise<void> | void;
  avatarStore?: AvatarStore;
  renderPdfPage?: (bytes: Uint8Array, page: number) => Promise<Uint8Array>;
}

export function registerProfileRoutes(app: FastifyInstance, dependencies: ProfileRouteDependencies): void {
  const documents = createDocumentRepository(dependencies.database);
  const renderPdfPage = dependencies.renderPdfPage ?? renderProfilePdfPage;
  const notifyProfileUpdated = (): void => {
    try {
      const result = dependencies.onProfileUpdated?.();
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Profile persistence has already succeeded; refresh is best effort.
    }
  };
  const currentSummary = (document: NonNullable<ReturnType<typeof documents.findCurrent>>) =>
    CurrentProfileDocumentSummarySchema.parse({
      documentId: document.id,
      filename: document.filename,
      importedAt: document.createdAt,
      importStatus: document.importStatus,
      extractedFactCount: dependencies.profileRepository.listActive().filter((fact) =>
        fact.scope === "profile" && fact.evidence.some((evidence) => evidence.documentId === document.fingerprint)
      ).length
    });

  app.post("/api/documents", async (request, reply) => {
    if (!request.isMultipart()) return sendError(reply, 400, "Invalid request");

    try {
      const upload = await readMultipartUpload(request);
      if (!hasPdfSignature(upload.bytes)) return sendError(reply, 400, "Invalid PDF upload", "invalid_pdf_upload");

      const imported = DocumentResponseSchema.parse(
        await importProfileDocument(dependencies, upload.filename, upload.bytes)
      );
      return reply.code(202).send(imported);
    } catch (error) {
      if (error instanceof DuplicateDocumentError) return sendError(reply, 409, "Document already imported", "document_already_imported");
      if (error instanceof InvalidPdfError) return sendError(reply, 400, "Invalid PDF upload", "invalid_pdf_upload");
      if (error instanceof ProfileImportUnavailableError) {
        return sendError(reply, 503, "Profile import is temporarily unavailable", "profile_import_unavailable");
      }
      if (error instanceof MultipartInputError) {
        return sendError(
          reply,
          400,
          error.publicMessage,
          error.publicMessage === "Invalid PDF upload" ? "invalid_pdf_upload" : "invalid_request"
        );
      }
      throw error;
    }
  });

  app.post("/api/profile/documents/current", async (request, reply) => {
    if (!request.isMultipart()) return sendError(reply, 400, "Invalid request", "invalid_request");
    try {
      const upload = await readMultipartUpload(request);
      if (!hasPdfSignature(upload.bytes)) return sendError(reply, 400, "Invalid PDF upload", "invalid_pdf_upload");
      const document = await retainCurrentProfileDocument(dependencies, upload.filename, upload.bytes);
      return reply.code(201).send(currentSummary(document));
    } catch (error) {
      if (error instanceof MultipartInputError) {
        return sendError(
          reply,
          400,
          error.publicMessage,
          error.publicMessage === "Invalid PDF upload" ? "invalid_pdf_upload" : "invalid_request"
        );
      }
      throw error;
    }
  });

  app.get("/api/profile/documents/current", async (_request, reply) => {
    const document = documents.findCurrent();
    return reply.code(200).send({ document: document === undefined ? null : currentSummary(document) });
  });

  app.post("/api/profile/documents/:documentId/parse", async (request, reply) => {
    const params = DocumentIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "Invalid request", "invalid_request");
    try {
      await parseCurrentProfileDocument(dependencies, params.data.documentId);
      const document = documents.findById(params.data.documentId);
      if (document === undefined) return sendError(reply, 404, "Document not found", "document_not_found");
      notifyProfileUpdated();
      return reply.code(200).send(currentSummary(document));
    } catch (error) {
      if (error instanceof CurrentDocumentChangedError) {
        return sendError(reply, 409, "Current document changed", "current_document_changed");
      }
      if (error instanceof DocumentImportInProgressError) {
        return sendError(reply, 409, "Document import is in progress", "document_import_in_progress");
      }
      if (error instanceof InvalidPdfError) return sendError(reply, 400, "Invalid PDF upload", "invalid_pdf_upload");
      if (error instanceof ProfileImportUnavailableError) {
        return sendError(reply, 503, "Profile import is temporarily unavailable", "profile_import_unavailable");
      }
      if (error instanceof Error && error.message === "document_not_found") {
        return sendError(reply, 404, "Document not found", "document_not_found");
      }
      throw error;
    }
  });

  app.post("/api/profile/avatar", async (request, reply) => {
    if (dependencies.avatarStore === undefined || !request.isMultipart()) return sendError(reply, 400, "Invalid request", "invalid_request");
    let upload: Awaited<ReturnType<typeof readAvatarUpload>>;
    try {
      upload = await readAvatarUpload(request);
    } catch {
      return sendError(reply, 400, "头像文件无效", "invalid_avatar_upload");
    }
    if (upload === undefined || !hasImageSignature(upload.bytes, upload.mimeType)) {
      return sendError(reply, 400, "头像文件无效", "invalid_avatar_upload");
    }
    return reply.code(201).send(await dependencies.avatarStore.save(upload.bytes, upload.mimeType));
  });

  app.get("/api/profile/facts", async (_request, reply) => {
    return reply.code(200).send(z.array(ProfileFactSchema).parse(dependencies.profileRepository.listActive()));
  });

  app.post("/api/profile/facts", async (request, reply) => {
    const body = ProfileFactUpsertInputSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "Invalid request");
    const fact = ProfileFactSchema.parse(dependencies.profileRepository.upsertUserFact(body.data));
    notifyProfileUpdated();
    return reply.code(200).send(fact);
  });

  app.delete("/api/profile/facts", async (request, reply) => {
    const body = ProfileFactRemovalInputSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "Invalid request");
    const result = ProfileFactRemovalResultSchema.parse({
      removed: dependencies.profileRepository.removeProfileFacts(body.data.fieldPaths)
    });
    if (result.removed > 0) notifyProfileUpdated();
    return reply.code(200).send(result);
  });

  app.get("/api/profile/completeness", async (_request, reply) => {
    return reply.code(200).send(ProfileCompletenessSchema.parse(
      calculateProfileCompleteness(dependencies.profileRepository.listActive())
    ));
  });

  app.get("/api/profile/documents/latest", async (_request, reply) => {
    const document = documents.findLatestCompleted();
    if (!document) {
      return reply.code(200).send(LatestProfileDocumentResponseSchema.parse({ document: null }));
    }
    const extractedFactCount = dependencies.profileRepository.listActive().filter((fact) =>
      fact.scope === "profile" && fact.evidence.some((evidence) => evidence.documentId === document.fingerprint)
    ).length;
    return reply.code(200).send(LatestProfileDocumentResponseSchema.parse({
      document: {
        documentId: document.id,
        filename: document.filename,
        importedAt: document.createdAt,
        extractedFactCount
      }
    }));
  });

  app.get("/api/profile/documents/:fingerprint/pdf", async (request, reply) => {
    const params = DocumentFingerprintParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "Invalid request");
    const document = documents.findByFingerprint(params.data.fingerprint);
    if (!document || document.importStatus !== "completed") return sendError(reply, 404, "Document not found");

    const filename = basename(document.filename).replace(/[\r\n]/g, "_") || "resume.pdf";
    const fallbackFilename = /^[\x20-\x7e]+$/.test(filename)
      ? filename.replace(/["\\]/g, "_")
      : "resume.pdf";
    const bytes = await readFile(document.sourcePath);
    return reply
      .code(200)
      .type("application/pdf")
      .header(
        "Content-Disposition",
        `inline; filename="${fallbackFilename}"; filename*=UTF-8''${encodeContentDispositionFilename(filename)}`
      )
      .header("Cache-Control", "private, max-age=3600")
      .send(bytes);
  });

  app.get("/api/profile/documents/:fingerprint/pages/:page/image", async (request, reply) => {
    const params = DocumentPageParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "Invalid request");
    const document = documents.findByFingerprint(params.data.fingerprint);
    if (!document || document.importStatus !== "completed") return sendError(reply, 404, "Document not found");
    try {
      const image = await renderPdfPage(await readFile(document.sourcePath), params.data.page);
      return reply
        .code(200)
        .type("image/png")
        .header("Cache-Control", "private, max-age=3600")
        .send(image);
    } catch (error) {
      if (error instanceof RangeError) return sendError(reply, 404, "Document page not found");
      throw error;
    }
  });

  app.get("/api/profile/documents/:fingerprint/pages/:page/grounding", async (request, reply) => {
    const params = DocumentPageParamsSchema.safeParse(request.params);
    const query = GroundingQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return sendError(reply, 400, "Invalid request");
    const content = documents.findPageContent(params.data.fingerprint, params.data.page);
    if (content === undefined) return sendError(reply, 404, "Document page not found");
    return reply.code(200).send(findEvidenceGrounding(content, query.data.text));
  });

  app.post("/api/profile/facts/:id/confirm", async (request, reply) => {
    const params = FactIdParamsSchema.safeParse(request.params);
    const body = ConfirmationBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "Invalid request");
    try {
      const fact = ProfileFactSchema.parse(dependencies.profileRepository.confirm(params.data.id));
      notifyProfileUpdated();
      return reply.code(200).send(fact);
    } catch (error) {
      return profileFactError(error, reply);
    }
  });

  app.post("/api/profile/facts/:id/correct", async (request, reply) => {
    const params = FactIdParamsSchema.safeParse(request.params);
    const body = CorrectionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "Invalid request");
    try {
      const fact = ProfileFactSchema.parse(dependencies.profileRepository.correct(params.data.id, body.data.value, [{
          documentId: "user",
          page: 1,
          text: `Corrected value: ${JSON.stringify(body.data.value)}`,
          extraction: "user"
        }]));
      notifyProfileUpdated();
      return reply.code(200).send(fact);
    } catch (error) {
      return profileFactError(error, reply);
    }
  });
}

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  const header = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024))).toString("latin1");
  return header.includes("%PDF-");
}

function readMultipartUpload(request: FastifyRequest): Promise<{ filename: string; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    let parser: BusboyParser;
    try {
      parser = new BusboyConstructor({
        headers: request.headers as { "content-type": string },
        limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_PDF_BYTES }
      });
    } catch {
      request.raw.resume();
      request.raw.once("end", () => reject(new MultipartInputError()));
      return;
    }

    let upload: { filename: string; bytes: Buffer } | undefined;
    let invalid: MultipartInputError | undefined;

    const invalidate = (message: "Invalid request" | "Invalid PDF upload" = "Invalid request"): void => {
      invalid ??= new MultipartInputError(message);
    };

    parser.on("file", (fieldname, file, filename, _encoding, mimetype) => {
      consumeFile(file, (bytes) => {
        if (upload) {
          invalidate();
          return;
        }
        const metadata = UploadMetadataSchema.safeParse({ fieldname, filename, mimetype });
        if (!metadata.success) {
          invalidate(mimetype === "application/pdf" ? "Invalid request" : "Invalid PDF upload");
          return;
        }
        upload = { filename: metadata.data.filename, bytes };
      }, invalidate);
    });
    parser.on("field", () => invalidate());
    parser.on("partsLimit", () => invalidate());
    parser.on("filesLimit", () => invalidate());
    parser.on("fieldsLimit", () => invalidate());
    parser.on("error", () => invalidate());
    request.raw.on("error", () => invalidate());
    request.raw.on("aborted", () => invalidate());
    parser.on("finish", () => {
      if (invalid) {
        reject(invalid);
      } else if (!upload) {
        reject(new MultipartInputError("Invalid PDF upload"));
      } else {
        resolve(upload);
      }
    });

    request.raw.pipe(parser);
  });
}

function consumeFile(
  file: BusboyFileStream,
  onComplete: (bytes: Buffer) => void,
  onInvalid: () => void
): void {
  const chunks: Buffer[] = [];
  file.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  file.on("limit", onInvalid);
  file.on("error", onInvalid);
  file.on("end", () => {
    if (file.truncated) onInvalid();
    onComplete(Buffer.concat(chunks));
  });
}

function hasImageSignature(bytes: Uint8Array, mimeType: AvatarMimeType): boolean {
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
    && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
}

function readAvatarUpload(request: FastifyRequest): Promise<{ bytes: Buffer; mimeType: AvatarMimeType } | undefined> {
  return new Promise((resolve, reject) => {
    let parser: BusboyParser;
    try {
      parser = new BusboyConstructor({
        headers: request.headers as { "content-type": string },
        limits: { files: 1, fields: 0, parts: 1, fileSize: 5 * 1024 * 1024 }
      });
    } catch {
      request.raw.resume();
      reject(new MultipartInputError());
      return;
    }
    let result: { bytes: Buffer; mimeType: AvatarMimeType } | undefined;
    let invalid = false;
    parser.on("file", (fieldname, file, _filename, _encoding, mimetype) => {
      const allowed = new Set<AvatarMimeType>(["image/jpeg", "image/png", "image/webp"]);
      if (fieldname !== "file" || !allowed.has(mimetype as AvatarMimeType)) {
        file.resume();
        return;
      }
      consumeFile(file, (bytes) => { result = { bytes, mimeType: mimetype as AvatarMimeType }; }, () => { invalid = true; });
    });
    parser.on("partsLimit", () => { invalid = true; });
    parser.on("filesLimit", () => { invalid = true; });
    parser.on("fieldsLimit", () => { invalid = true; });
    parser.on("field", () => { invalid = true; });
    parser.once("error", () => { invalid = true; });
    parser.once("finish", () => resolve(invalid ? undefined : result));
    request.raw.pipe(parser);
  });
}

function profileFactError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof Error && error.message.startsWith("profile fact not found:")) {
    return sendError(reply, 404, "Profile fact not found");
  }
  throw error;
}
