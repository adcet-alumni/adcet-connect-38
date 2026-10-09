/**
 * S3-compatible storage adapter. Works with AWS S3 or any S3-compatible service
 * (MinIO, Cloudflare R2, Backblaze B2). Selection is driven by `S3_ENDPOINT`
 * + `S3_FORCE_PATH_STYLE` in env.
 */
import {
  S3Client,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  buildObjectKey,
  type PresignUploadInput,
  type PresignUploadResult,
  type StorageService,
} from "./StorageService.js";

export class S3Storage implements StorageService {
  private client: S3Client;
  private bucket: string;

  constructor(opts?: { ensureBucket?: boolean }) {
    this.bucket = env.STORAGE_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      ...(env.S3_ACCESS_KEY && env.S3_SECRET_KEY
        ? { credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } }
        : {}),
    });
    this.shouldEnsureBucket = Boolean(opts?.ensureBucket);
    // Warm up eagerly, but don't fail the boot — ensureReady() retries on
    // every upload until it succeeds (MinIO may start after the backend).
    void this.ensureReady();
  }

  private shouldEnsureBucket: boolean;
  private bucketEnsured = false;
  private ensureInFlight: Promise<void> | null = null;

  /** Await bucket existence before serving uploads; retries across calls. */
  private async ensureReady(): Promise<void> {
    if (!this.shouldEnsureBucket || this.bucketEnsured) return;
    this.ensureInFlight ??= this.ensureBucket().finally(() => {
      this.ensureInFlight = null;
    });
    await this.ensureInFlight;
  }

  /**
   * Scopes whose objects must never be publicly readable. Downloads go
   * through presigned URLs; the bucket policy below excludes their key
   * prefixes from the public `s3:GetObject` statement.
   */
  private static PRIVATE_PREFIXES = ["resume", "receipt", "donation-proof", "identity", "backup"];

  /**
   * Dev-MinIO convenience: create the bucket if it doesn't exist. For
   * production AWS S3 the bucket should already exist with its own IAM
   * policy — this path only fires when `ensureBucket` is true (i.e.
   * STORAGE_DRIVER=minio).
   *
   * The policy grants public read on every key *except* the private
   * scopes (resume, receipt, donation-proof, identity, backup), which
   * are only reachable through the pre-signed download URLs the API
   * issues after an authorisation check.
   */
  private async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.bucketEnsured = true;
      return;
    } catch {
      // Missing (or MinIO unreachable) — attempt to create below.
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      await this.client.send(
        new PutBucketPolicyCommand({
          Bucket: this.bucket,
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "PublicReadNonPrivateScopes",
                Effect: "Allow",
                Principal: "*",
                Action: ["s3:GetObject"],
                Resource: [`arn:aws:s3:::${this.bucket}/*`],
                Condition: {
                  StringNotLike: {
                    "s3:prefix": S3Storage.PRIVATE_PREFIXES.map((p) => `${p}/*`),
                  },
                },
              },
              // Explicit deny on private prefixes so no other statement can override.
              {
                Sid: "DenyPublicReadPrivateScopes",
                Effect: "Deny",
                Principal: "*",
                Action: ["s3:GetObject"],
                Resource: S3Storage.PRIVATE_PREFIXES.map(
                  (p) => `arn:aws:s3:::${this.bucket}/${p}/*`,
                ),
                Condition: {
                  StringNotLike: {
                    "aws:Referer": ["presigned-url-request"],
                  },
                },
              },
            ],
          }),
        }),
      );
      this.bucketEnsured = true;
      logger.info(`[storage] created missing bucket "${this.bucket}" with scope-restricted public-read policy`);
    } catch (e) {
      logger.error({ err: e }, `[storage] could not verify/create bucket "${this.bucket}" — will retry on next upload`);
    }
  }

  /**
   * A presigned PUT is a bearer capability, so its size has to be part of what
   * was signed — otherwise the 10 MB the form promised is advisory and the
   * holder of the URL can push a gigabyte. Passing `ContentLength` and naming
   * `content-length` as a signable header puts it in `X-Amz-SignedHeaders`:
   * S3/MinIO then recompute the signature over the length the client actually
   * sends, and a mismatched body is rejected at the bucket. The browser sets
   * `Content-Length` itself for a `File` body, so `src/lib/upload.ts` needs no
   * header of its own — it only has to declare the same number at presign time.
   */
  async presignUpload(input: PresignUploadInput): Promise<PresignUploadResult> {
    await this.ensureReady();
    const key = buildObjectKey(input);
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: input.contentType,
      ...(input.size != null ? { ContentLength: input.size } : {}),
      // Encrypt at rest — S3 managed key (SSE-S3).
      ServerSideEncryption: "AES256",
    });
    const uploadUrl = await getSignedUrl(this.client, cmd, {
      expiresIn: env.S3_PRESIGN_TTL,
      ...(input.size != null
        ? { signableHeaders: new Set(["host", "content-length"]) }
        : {}),
    });
    return { uploadUrl, key, publicUrl: this.publicUrl(key), expiresIn: env.S3_PRESIGN_TTL };
  }

  async upload(input: PresignUploadInput & { body: Buffer }): Promise<{ key: string; publicUrl: string }> {
    await this.ensureReady();
    const key = buildObjectKey(input);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: input.contentType,
        Body: input.body,
        // Encrypt at rest — S3 managed key (SSE-S3).
        ServerSideEncryption: "AES256",
      }),
    );
    return { key, publicUrl: this.publicUrl(key) };
  }

  async presignDownload(key: string, expiresIn = env.S3_PRESIGN_TTL): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn });
  }

  publicUrl(key: string): string {
    if (env.STORAGE_PUBLIC_BASE_URL) return `${env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
    if (env.S3_ENDPOINT) return `${env.S3_ENDPOINT.replace(/\/$/, "")}/${this.bucket}/${key}`;
    return `https://${this.bucket}.s3.${env.S3_REGION}.amazonaws.com/${key}`;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
