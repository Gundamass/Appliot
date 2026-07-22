import { Busboy as BusboyConstructor, type Busboy as BusboyParser, type BusboyFileStream } from "@fastify/busboy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DocumentResponseSchema, JsonValueSchema, ProfileFactSchema } from "@resume/contracts";
import { sendError } from "../http-response.js";
import {
  DuplicateDocumentError,
  InvalidPdfError,
  MAX_PDF_BYTES,
  ProfileImportUnavailableError,
  importProfileDocument,
  type ProfileImportDependencies
} from "./import-service.js";
import type { ProfileRepository } from "./profile-repository.js";

const FactIdParamsSchema = z.object({ id: z.string().min(1).max(128) });
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
}

export function registerProfileRoutes(app: FastifyInstance, dependencies: ProfileRouteDependencies): void {
  app.post("/api/documents", async (request, reply) => {
    if (!request.isMultipart()) return sendError(reply, 400, "Invalid request");

    try {
      const upload = await readMultipartUpload(request);
      if (!hasPdfSignature(upload.bytes)) return sendError(reply, 400, "Invalid PDF upload");

      const imported = DocumentResponseSchema.parse(
        await importProfileDocument(dependencies, upload.filename, upload.bytes)
      );
      return reply.code(202).send(imported);
    } catch (error) {
      if (error instanceof DuplicateDocumentError) return sendError(reply, 409, "Document already imported");
      if (error instanceof InvalidPdfError) return sendError(reply, 400, "Invalid PDF upload");
      if (error instanceof ProfileImportUnavailableError) {
        return sendError(reply, 503, "Profile import is temporarily unavailable");
      }
      if (error instanceof MultipartInputError) return sendError(reply, 400, error.publicMessage);
      throw error;
    }
  });

  app.get("/api/profile/facts", async (_request, reply) => {
    return reply.code(200).send(z.array(ProfileFactSchema).parse(dependencies.profileRepository.listActive()));
  });

  app.post("/api/profile/facts/:id/confirm", async (request, reply) => {
    const params = FactIdParamsSchema.safeParse(request.params);
    const body = ConfirmationBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "Invalid request");
    try {
      return reply.code(200).send(ProfileFactSchema.parse(dependencies.profileRepository.confirm(params.data.id)));
    } catch (error) {
      return profileFactError(error, reply);
    }
  });

  app.post("/api/profile/facts/:id/correct", async (request, reply) => {
    const params = FactIdParamsSchema.safeParse(request.params);
    const body = CorrectionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "Invalid request");
    try {
      return reply.code(200).send(ProfileFactSchema.parse(
        dependencies.profileRepository.correct(params.data.id, body.data.value, [{
          documentId: "user",
          page: 1,
          text: `Corrected value: ${JSON.stringify(body.data.value)}`,
          extraction: "user"
        }])
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

function profileFactError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof Error && error.message.startsWith("profile fact not found:")) {
    return sendError(reply, 404, "Profile fact not found");
  }
  throw error;
}
