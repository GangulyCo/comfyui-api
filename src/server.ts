import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import fsPromises from "fs/promises";
import fs from "fs";
import path from "path";
import config from "./config";
import {
  processImageOrVideo,
  zodToMarkdownTable,
  convertImageBuffer,
  getConfiguredWebhookHandlers,
  fetchWithRetries,
  setDeletionCost,
  uploadFileToS3,
} from "./utils";
import {
  warmupComfyUI,
  waitForComfyUIToStart,
  launchComfyUI,
  shutdownComfyUI,
  runPromptAndGetOutputs,
  connectToComfyUIWebsocketStream,
} from "./comfy";
import {
  PromptRequestSchema,
  PromptErrorResponseSchema,
  PromptResponseSchema,
  PromptRequest,
  WorkflowResponseSchema,
  WorkflowTree,
  isWorkflow,
  OutputConversionOptionsSchema,
} from "./types";
import workflows from "./workflows";
import { z } from "zod";
import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import { fetch, Agent } from "undici";

const { apiVersion: version } = config;

const server = Fastify({
  bodyLimit: config.maxBodySize,
  logger: { level: config.logLevel },
  connectionTimeout: 0,
  keepAliveTimeout: 0,
  requestTimeout: 0,
});
server.setValidatorCompiler(validatorCompiler);
server.setSerializerCompiler(serializerCompiler);

const modelSchema: any = {};
for (const modelType in config.models) {
  modelSchema[modelType] = z.string().array();
}

const ModelResponseSchema = z.object(modelSchema);
type ModelResponse = z.infer<typeof ModelResponseSchema>;

const modelResponse: ModelResponse = {};
for (const modelType in config.models) {
  modelResponse[modelType] = config.models[modelType].all;
}

let warm = false;
let wasEverWarm = false;
let queueDepth = 0;

server.register(fastifySwagger, {
  openapi: {
    openapi: "3.0.0",
    info: {
      title: "ComfyUI API",
      version,
    },
    servers: [
      {
        url: `{accessDomainName}`,
        description: "Your server",
        variables: {
          accessDomainName: {
            default: `http://localhost:${config.wrapperPort}`,
            description:
              "The domain name of the server, protocol included, port optional",
          },
        },
      },
    ],
  },
  transform: jsonSchemaTransform,
});
server.register(fastifySwaggerUI, {
  routePrefix: "/docs",
  uiConfig: {
    deepLinking: true,
  },
});

server.after(() => {
  const app = server.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/health",
    {
      schema: {
        summary: "Health Probe",
        description: "Check if the server is healthy",
        response: {
          200: z.object({
            version: z.literal(version),
            status: z.literal("healthy"),
          }),
          500: z.object({
            version: z.literal(version),
            status: z.literal("not healthy"),
          }),
        },
      },
    },
    async (request, reply) => {
      // 200 if ready, 500 if not
      if (wasEverWarm) {
        return reply.code(200).send({ version, status: "healthy" });
      }
      return reply.code(500).send({ version, status: "not healthy" });
    }
  );

  app.get(
    "/ready",
    {
      schema: {
        summary: "Readiness Probe",
        description: "Check if the server is ready to serve traffic",
        response: {
          200: z.object({
            version: z.literal(version),
            status: z.literal("ready"),
          }),
          503: z.object({
            version: z.literal(version),
            status: z.literal("not ready"),
          }),
        },
      },
    },
    async (request, reply) => {
      if (
        warm &&
        (!config.maxQueueDepth || queueDepth < config.maxQueueDepth)
      ) {
        return reply.code(200).send({ version, status: "ready" });
      }
      return reply.code(503).send({ version, status: "not ready" });
    }
  );

  app.get(
    "/models",
    {
      schema: {
        summary: "List Models",
        description:
          "List all available models. This is from the contents of the models directory.",
        response: {
          200: ModelResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return modelResponse;
    }
  );

  app.get<{
    Params: { filename: string };
  }>(
    "/download/:filename",
    {
      schema: {
        summary: "Download Output File",
        description: "Download an output file by its filename.",
        params: z.object({
          filename: z.string().describe("The name of the file to download"),
        }),
        response: {
          200: z.any().describe("The file content"),
          404: z.object({
            error: z.string(),
          }),
          500: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { filename } = request.params;
      const filePath = path.join(config.outputDir, filename);

      try {
        // Check if file exists and is within the output directory
        const resolvedPath = path.resolve(filePath);
        const outputDirResolved = path.resolve(config.outputDir);
        
        if (!resolvedPath.startsWith(outputDirResolved)) {
          return reply.code(404).send({
            error: "File not found",
          });
        }

        // Check if file exists
        await fsPromises.access(filePath, fs.constants.F_OK);
        
        // Get file stats to determine content type
        const stats = await fsPromises.stat(filePath);
        if (!stats.isFile()) {
          return reply.code(404).send({
            error: "File not found",
          });
        }

        // Determine content type based on file extension
        const ext = path.extname(filename).toLowerCase();
        let contentType = "application/octet-stream";
        
        if (ext === ".png") {
          contentType = "image/png";
        } else if (ext === ".jpg" || ext === ".jpeg") {
          contentType = "image/jpeg";
        } else if (ext === ".gif") {
          contentType = "image/gif";
        } else if (ext === ".webp") {
          contentType = "image/webp";
        } else if (ext === ".mp4") {
          contentType = "video/mp4";
        } else if (ext === ".webm") {
          contentType = "video/webm";
        } else if (ext === ".mov") {
          contentType = "video/quicktime";
        }

        // Set headers
        reply.header("Content-Type", contentType);
        reply.header("Content-Disposition", `attachment; filename="${filename}"`);
        reply.header("Content-Length", stats.size);

        // Stream the file
        const fileStream = fs.createReadStream(filePath);
        return reply.send(fileStream);
      } catch (error: any) {
        if (error.code === "ENOENT") {
          return reply.code(404).send({
            error: "File not found",
          });
        }
        
        request.log.error(`Error downloading file ${filename}: ${error.message}`);
        return reply.code(500).send({
          error: "Internal server error",
        });
      }
    }
  );

  app.get(
    "/files",
    {
      schema: {
        summary: "List Output Files",
        description: "List all available output files in the output directory.",
        response: {
          200: z.object({
            files: z.array(z.object({
              name: z.string(),
              size: z.number(),
              modified: z.string(),
            })),
          }),
          500: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      try {
        const files = await fsPromises.readdir(config.outputDir);
        const fileStats = await Promise.all(
          files.map(async (filename) => {
            const filePath = path.join(config.outputDir, filename);
            try {
              const stats = await fsPromises.stat(filePath);
              if (stats.isFile()) {
                return {
                  name: filename,
                  size: stats.size,
                  modified: stats.mtime.toISOString(),
                };
              }
              return null;
            } catch {
              return null;
            }
          })
        );
        
        const validFiles = fileStats.filter((file): file is { name: string; size: number; modified: string } => file !== null);
        return reply.send({ files: validFiles });
      } catch (error: any) {
        request.log.error(`Error listing files: ${error.message}`);
        return reply.code(500).send({
          error: "Internal server error",
        });
      }
    }
  );

  /**
   * This route is the primary wrapper around the ComfyUI /prompt endpoint.
   * It shares the same schema as the ComfyUI /prompt endpoint, but adds the
   * ability to convert the output image to a different format, and to send
   * the output image to a webhook, or return it in the response.
   *
   * If your application has it's own ID scheme, you can provide the ID in the
   * request body. If you don't provide an ID, one will be generated for you.
   */
  app.post<{
    Body: PromptRequest;
  }>(
    "/prompt",
    {
      schema: {
        summary: "Submit Prompt",
        description: "Submit an API-formatted ComfyUI prompt.",
        body: PromptRequestSchema,
        response: {
          200: PromptResponseSchema,
          202: PromptResponseSchema,
          400: PromptErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      let { prompt, id, webhook, convert_output, s3 } = request.body;
      let contentType = "image/png";
      if (convert_output) {
        contentType = `image/${convert_output.format}`;
      }

      /**
       * Here we go through all the nodes in the prompt to validate it,
       * and also to do some pre-processing.
       */
      let hasSaveImage = false;
      const loadImageNodes = new Set<string>([
        "LoadImage",
        "LoadImageMask",
        "LoadImageOutput",
        "VHS_LoadImagePath",
      ]);
      const loadDirectoryOfImagesNodes = new Set<string>([
        "VHS_LoadImages",
        "VHS_LoadImagesPath",
      ]);
      const loadVideoNodes = new Set<string>([
        "LoadVideo",
        "VHS_LoadVideo",
        "VHS_LoadVideoPath",
        "VHS_LoadVideoFFmpegPath",
        "VHS_LoadVideoFFmpeg",
      ]);
      for (const nodeId in prompt) {
        const node = prompt[nodeId];
        if (
          node.inputs.filename_prefix &&
          typeof node.inputs.filename_prefix === "string"
        ) {
          /**
           * If the node is for saving files, we want to set the filename_prefix
           * to the id of the prompt. This ensures no collisions between prompts
           * from different users.
           */
          node.inputs.filename_prefix = id;
          if (
            typeof node.inputs.save_output !== "undefined" &&
            !node.inputs.save_output
          ) {
            continue;
          }
          hasSaveImage = true;
        } else if (
          loadImageNodes.has(node.class_type) &&
          typeof node.inputs.image === "string"
        ) {
          /**
           * If the node is for loading an image, the user will have provided
           * the image as base64 encoded data, or as a url. we need to download
           * the image if it's a url, and save it to a local file.
           */
          const imageInput = node.inputs.image;
          try {
            node.inputs.image = await processImageOrVideo(imageInput, app.log);
          } catch (e: any) {
            return reply.code(400).send({
              error: e.message,
              location: `prompt.${nodeId}.inputs.image`,
            });
          }
        } else if (
          loadDirectoryOfImagesNodes.has(node.class_type) &&
          Array.isArray(node.inputs.directory) &&
          node.inputs.directory.every((x: any) => typeof x === "string")
        ) {
          /**
           * If the node is for loading a directory of images, the user will have
           * provided the local directory as a string or an array of strings. If it's an
           * array, we need to download each image to a local file, and update the input
           * to be the local directory.
           */
          try {
            /**
             * We need to download each image to a local file.
             */
            app.log.debug(
              `Downloading images to local directory for node ${nodeId}`
            );
            const processPromises: Promise<string>[] = [];
            for (const b64 of node.inputs.directory) {
              processPromises.push(processImageOrVideo(b64, app.log, id));
            }
            await Promise.all(processPromises);
            node.inputs.directory = id;
            app.log.debug(`Saved images to local directory for node ${nodeId}`);
          } catch (e: any) {
            return reply.code(400).send({
              error: e.message,
              location: `prompt.${nodeId}.inputs.directory`,
              message: "Failed to download images to local directory",
            });
          }
        } else if (
          loadVideoNodes.has(node.class_type) &&
          typeof node.inputs.video === "string"
        ) {
          /**
           * If the node is for loading a video, the user will have provided
           * the video as base64 encoded data, or as a url. we need to download
           * the video if it's a url, and save it to a local file.
           */
          const videoInput = node.inputs.video;
          try {
            node.inputs.video = await processImageOrVideo(videoInput, app.log);
          } catch (e: any) {
            return reply.code(400).send({
              error: e.message,
              location: `prompt.${nodeId}.inputs.video`,
            });
          }
        } else if (
          loadVideoNodes.has(node.class_type) &&
          typeof node.inputs.file === "string"
        ) {
          /**
           * If the node is for loading a video file, the user will have provided
           * the video file as base64 encoded data, or as a url. we need to download
           * the video if it's a url, and save it to a local file.
           */
          const videoInput = node.inputs.file;
          try {
            node.inputs.file = await processImageOrVideo(videoInput, app.log);
          } catch (e: any) {
            return reply.code(400).send({
              error: e.message,
              location: `prompt.${nodeId}.inputs.file`,
            });
          }
        }
      }

      /**
       * If the prompt has no outputs, there's no point in running it.
       */
      if (!hasSaveImage) {
        return reply.code(400).send({
          error:
            'Prompt must contain a node with a "filename_prefix" input, such as "SaveImage"',
          location: "prompt",
        });
      }

      if (webhook) {
        /**
         * Send the prompt to ComfyUI, and return a 202 response to the user.
         */
        runPromptAndGetOutputs(id, prompt, app.log)
          .then(
            /**
             * This function does not block returning the 202 response to the user.
             */
            async (outputs: Record<string, Buffer>) => {
              const filenames: string[] = [];
              
              for (const originalFilename in outputs) {
                let filename = originalFilename;
                let fileBuffer = outputs[filename];
                if (convert_output) {
                  try {
                    fileBuffer = await convertImageBuffer(
                      fileBuffer,
                      convert_output
                    );

                    /**
                     * If the user has provided an output format, we need to update the filename
                     */
                    filename = originalFilename.replace(
                      /\.[^/.]+$/,
                      `.${convert_output.format}`
                    );
                    
                    // Save the converted file back to disk
                    await fsPromises.writeFile(path.join(config.outputDir, filename), fileBuffer);
                  } catch (e: any) {
                    app.log.warn(`Failed to convert image: ${e.message}`);
                    filename = originalFilename; // Fall back to original filename if conversion fails
                  }
                }
                
                filenames.push(filename);
                
                // Only remove the original file if we converted it to a different format
                if (convert_output && filename !== originalFilename) {
                  fsPromises.unlink(path.join(config.outputDir, originalFilename));
                }
              }
              
              // Send webhook with filenames instead of base64 content
              app.log.info(
                `Sending ${filenames.length} filename(s) to webhook: ${webhook}`
              );
              
              fetchWithRetries(
                webhook,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    event: "output.complete",
                    filenames,
                    id,
                    prompt,
                  }),
                  dispatcher: new Agent({
                    headersTimeout: 0,
                    bodyTimeout: 0,
                    connectTimeout: 0,
                  }),
                },
                config.promptWebhookRetries,
                app.log
              )
                .catch((e: any) => {
                  app.log.error(
                    `Failed to send filenames to webhook: ${e.message}`
                  );
                })
                .then(async (resp) => {
                  if (!resp) {
                    app.log.error("No response from webhook");
                  } else if (!resp.ok) {
                    app.log.error(
                      `Failed to send filenames to webhook: ${await resp.text()}`
                    );
                  } else {
                    app.log.info(`Sent ${filenames.length} filename(s) to webhook`);
                  }
                });
            }
          )
          .catch(async (e: any) => {
            /**
             * Send a webhook reporting that the generation failed.
             */
            app.log.error(`Failed to generate images: ${e.message}`);
            try {
              const resp = await fetchWithRetries(
                webhook,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    event: "prompt.failed",
                    id,
                    prompt,
                    error: e.message,
                  }),
                  dispatcher: new Agent({
                    headersTimeout: 0,
                    bodyTimeout: 0,
                    connectTimeout: 0,
                  }),
                },
                config.promptWebhookRetries,
                app.log
              );

              if (!resp.ok) {
                app.log.error(
                  `Failed to send failure message to webhook: ${await resp.text()}`
                );
              }
            } catch (e: any) {
              app.log.error(
                `Failed to send failure message to webhook: ${e.message}`
              );
            }
          });
        return reply.code(202).send({ status: "ok", id, webhook, prompt });
      } else if (s3 && s3.async) {
        runPromptAndGetOutputs(id, prompt, app.log)
          .then(async (outputs: Record<string, Buffer>) => {
            /**
             * If the user has provided an S3 configuration, we upload the images to S3.
             */
            const uploadPromises: Promise<void>[] = [];
            for (const originalFilename in outputs) {
              let filename = originalFilename;
              let fileBuffer = outputs[filename];
              if (convert_output) {
                try {
                  fileBuffer = await convertImageBuffer(
                    fileBuffer,
                    convert_output
                  );

                  /**
                   * If the user has provided an output format, we need to update the filename
                   */
                  filename = originalFilename.replace(
                    /\.[^/.]+$/,
                    `.${convert_output.format}`
                  );
                } catch (e: any) {
                  app.log.warn(`Failed to convert image: ${e.message}`);
                }
              }

              const key = `${s3.prefix}${filename}`;
              uploadPromises.push(
                uploadFileToS3(s3.bucket, key, fileBuffer, contentType, app.log)
              );
              app.log.info(
                `Uploading image ${filename} to s3://${s3.bucket}/${key}`
              );

              // Remove the file after uploading
              fsPromises.unlink(path.join(config.outputDir, originalFilename));
            }

            await Promise.all(uploadPromises);
          })
          .catch(async (e: any) => {
            app.log.error(`Failed to generate images: ${e.message}`);
          });
        return reply.code(202).send({ status: "ok", id, prompt, s3 });
      } else {
        /**
         * If the user has not provided a webhook or s3.async is false, we wait for the images to
         * be generated and then send them back in the response.
         */
        const images: string[] = [];
        const filenames: string[] = [];
        const uploadPromises: Promise<void>[] = [];

        /**
         * Send the prompt to ComfyUI, and wait for the images to be generated.
         */
        const allOutputs = await runPromptAndGetOutputs(id, prompt, app.log);
        for (const originalFilename in allOutputs) {
          let fileBuffer = allOutputs[originalFilename];
          let filename = originalFilename;

          if (convert_output) {
            try {
              fileBuffer = await convertImageBuffer(fileBuffer, convert_output);
              /**
               * If the user has provided an output format, we need to update the filename
               */
              filename = originalFilename.replace(
                /\.[^/.]+$/,
                `.${convert_output.format}`
              );
              
              // Save the converted file back to disk
              await fsPromises.writeFile(path.join(config.outputDir, filename), fileBuffer);
            } catch (e: any) {
              app.log.warn(`Failed to convert image: ${e.message}`);
              filename = originalFilename; // Fall back to original filename if conversion fails
            }
          }

          filenames.push(filename);
          if (!s3) {
            // Instead of base64 content, return the filename that can be used with /download endpoint
            images.push(filename);
          } else if (s3 && !s3.async) {
            const key = `${s3.prefix}${filename}`;
            uploadPromises.push(
              uploadFileToS3(s3.bucket, key, fileBuffer, contentType, app.log)
            );
            images.push(`s3://${s3.bucket}/${key}`);
            
            // Remove the file after uploading to S3
            fsPromises.unlink(path.join(config.outputDir, filename));
          }

          // Only remove the original file if we converted it to a different format
          if (convert_output && filename !== originalFilename) {
            fsPromises.unlink(path.join(config.outputDir, originalFilename));
          }
        }
        await Promise.all(uploadPromises);

        return reply.send({ id, images, filenames });
      }
    }
  );

  // Recursively build the route tree from workflows
  const walk = (tree: WorkflowTree, route = "/workflow") => {
    for (const key in tree) {
      const node = tree[key];
      if (isWorkflow(node)) {
        const BodySchema = z.object({
          id: z
            .string()
            .optional()
            .default(() => randomUUID()),
          input: node.RequestSchema,
          webhook: z.string().optional(),
          convert_output: OutputConversionOptionsSchema.optional(),
          s3: PromptRequestSchema.shape.s3.optional(),
        });

        type BodyType = z.infer<typeof BodySchema>;

        let description = "";
        if (config.markdownSchemaDescriptions) {
          description = zodToMarkdownTable(node.RequestSchema);
        } else if (node.description) {
          description = node.description;
        }

        let summary = key;
        if (node.summary) {
          summary = node.summary;
        }

        /**
         * Workflow endpoints expose a simpler API to users, and then perform the transformation
         * to a ComfyUI prompt behind the scenes. These endpoints under the hood just call the /prompt
         * endpoint with the appropriate parameters.
         */
        app.post<{
          Body: BodyType;
        }>(
          `${route}/${key}`,
          {
            schema: {
              summary,
              description,
              body: BodySchema,
              response: {
                200: WorkflowResponseSchema,
                202: WorkflowResponseSchema,
              },
            },
          },
          async (request, reply) => {
            const { id, input, webhook, convert_output, s3 } = request.body;
            const prompt = await node.generateWorkflow(input);

            const resp = await fetch(
              `http://localhost:${config.wrapperPort}/prompt`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ prompt, id, webhook, convert_output, s3 }),
                dispatcher: new Agent({
                  headersTimeout: 0,
                  bodyTimeout: 0,
                  connectTimeout: 0,
                }),
              }
            );
            const body = (await resp.json()) as any;
            if (!resp.ok) {
              return reply.code(resp.status).send(body);
            }

            body.input = input;
            body.prompt = prompt;

            return reply.code(resp.status).send(body);
          }
        );

        server.log.info(`Registered workflow ${route}/${key}`);
      } else {
        walk(node as WorkflowTree, `${route}/${key}`);
      }
    }
  };
  walk(workflows);
});

let comfyWebsocketClient: WebSocket | null = null;

process.on("SIGINT", async () => {
  server.log.info("Received SIGINT, interrupting process");
  shutdownComfyUI();
  if (comfyWebsocketClient) {
    comfyWebsocketClient.terminate();
  }
  process.exit(0);
});

async function launchComfyUIAndAPIServerAndWaitForWarmup() {
  warm = false;
  server.log.info(
    `Starting ComfyUI API ${config.apiVersion} with ComfyUI ${config.comfyVersion}`
  );
  launchComfyUI().catch((err: any) => {
    server.log.error(err.message);
    if (config.alwaysRestartComfyUI) {
      server.log.info("Restarting ComfyUI");
      launchComfyUIAndAPIServerAndWaitForWarmup();
    } else {
      server.log.info("Exiting");
      process.exit(1);
    }
  });
  await waitForComfyUIToStart(server.log);
  server.log.info(`ComfyUI ${config.comfyVersion} started.`);
  if (!wasEverWarm) {
    await server.ready();
    server.swagger();
    // Start the server
    await server.listen({ port: config.wrapperPort, host: config.wrapperHost });
    server.log.info(`ComfyUI API ${config.apiVersion} started.`);
  }
  const handlers = getConfiguredWebhookHandlers(server.log);
  if (handlers.onStatus) {
    const originalHandler = handlers.onStatus;
    handlers.onStatus = (msg) => {
      queueDepth = msg.data.status.exec_info.queue_remaining;
      server.log.debug(`Queue depth: ${queueDepth}`);
      setDeletionCost(queueDepth);
      originalHandler(msg);
    };
  } else {
    handlers.onStatus = (msg) => {
      queueDepth = msg.data.status.exec_info.queue_remaining;
      server.log.debug(`Queue depth: ${queueDepth}`);
      setDeletionCost(queueDepth);
    };
  }
  comfyWebsocketClient = await connectToComfyUIWebsocketStream(
    handlers,
    server.log,
    true
  );
  await warmupComfyUI();
  wasEverWarm = true;
  warm = true;
}

export async function start() {
  try {
    const start = Date.now();
    // Start ComfyUI
    await launchComfyUIAndAPIServerAndWaitForWarmup();
    const warmupTime = Date.now() - start;
    server.log.info(
      `Starting Comfy and any warmup workflow took ${warmupTime / 1000}s`
    );
  } catch (err: any) {
    server.log.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}
