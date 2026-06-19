import { countGenerationsSince, createGeneration, utcMonthStart } from "@/db/generations";
import { getMonthlyGenerationLimit } from "@/lib/generation-quota";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import sharp from "sharp";

import * as Sentry from "@sentry/nextjs";
import { geminiProvider } from "@/lib/gemini";
import { ACCEPTED_SOURCE_IMAGE_MIME_TYPES } from "@/lib/constants";
import { getStylePreset } from "@/lib/style-presets";
import { geminiImageModels } from "@/lib/gemini-image-models";

import { APICallError, generateImage, generateText, NoImageGeneratedError } from "ai";
import { uploadBufferToImageKit } from "@/lib/imagekit";

export const runtime = "nodejs";

type EditImageSize = "1024x1024" | "1536x1024" | "1024x1536";

type GenerateImageRequest = {
  sourceImageUrl?: string;
  sourceMimeType?: string;
  originalFileName?: string;
  styleSlug?: string;
  model?: string;
};

/**
 * inferImageSize reads width and height from the uploaded image (via sharp), computes aspect ratio,
 * and returns one of the allowed `size` values for image edits.
 */
async function inferImageSize(imageBuffer: Buffer): Promise<EditImageSize> {
  try {
    const metadata = await sharp(imageBuffer).metadata();

    if (!metadata.width || !metadata.height) {
      return "1024x1024";
    }

    const aspectRatio = metadata.width / metadata.height;

    if (aspectRatio > 1.08) return "1536x1024"; // wider than it is tall
    if (aspectRatio < 0.92) return "1024x1536"; // taller than it is wide
    return "1024x1024"; // square
  } catch {
    return "1024x1024";
  }
}

function mapSizeToAspectRatio(size: EditImageSize): "1:1" | "3:2" | "2:3" {
  if (size === "1536x1024") return "3:2";
  if (size === "1024x1536") return "2:3";
  return "1:1";
}

export async function POST(request: Request) {
  const { userId, has } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[STEP] Auth Success");

  const monthlyLimit = getMonthlyGenerationLimit(has);
  const usedThisMonth = await countGenerationsSince(userId, utcMonthStart());

  if (usedThisMonth >= monthlyLimit) {
    Sentry.logger.warn("generation.quota_exceeded", {
      limit: monthlyLimit,
      used: usedThisMonth,
    });

    return NextResponse.json(
      {
        error: `Monthly generation limit reached (${monthlyLimit} images). Upgrade your plan or try again next month.`,
        code: "QUOTA_EXCEEDED" as const,
        limit: monthlyLimit,
        used: usedThisMonth,
      },
      { status: 429 },
    );
  }

  console.log("[STEP] Quota Check Passed");

  if (!geminiProvider) {
    console.error("[DEBUG] GEMINI_API_KEY is missing!");
    return NextResponse.json({ error: "Missing GEMINI_API_KEY." }, { status: 500 });
  }

  let body: GenerateImageRequest;
  try {
    body = (await request.json()) as GenerateImageRequest;
  } catch (err) {
    console.error("[DEBUG] Failed to parse request JSON body:", err);
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  console.log("[STEP] Request Body", body);

  const { model, originalFileName, sourceImageUrl, sourceMimeType, styleSlug } = body;

  if (!sourceImageUrl) {
    console.error("[DEBUG] Validation failed: sourceImageUrl is missing.");
    return NextResponse.json({ error: "Please upload an image first." }, { status: 400 });
  }

  if (typeof sourceMimeType !== "string" || !ACCEPTED_SOURCE_IMAGE_MIME_TYPES.has(sourceMimeType)) {
    console.error("[DEBUG] Validation failed: sourceMimeType is invalid. Value:", sourceMimeType);
    return NextResponse.json(
      { error: "Only JPG, PNG, and WEBP files are supported." },
      { status: 400 },
    );
  }

  if (typeof styleSlug !== "string") {
    console.error("[DEBUG] Validation failed: styleSlug is not a string. Value:", styleSlug);
    return NextResponse.json({ error: "Please choose a style." }, { status: 400 });
  }

  if (!model) {
    console.error("[DEBUG] Validation failed: model is missing.");
    return NextResponse.json({ error: "Please choose a model." }, { status: 400 });
  }

  if (!geminiImageModels.includes(model as any)) {
    console.error(`[DEBUG] Validation failed: model name is invalid: ${model}`);
    return NextResponse.json({ error: `Invalid model name: ${model}` }, { status: 400 });
  }

  const preset = getStylePreset(styleSlug);
  if (!preset) {
    console.error("[DEBUG] Validation failed: preset not found for styleSlug:", styleSlug);
    return NextResponse.json({ error: "Unknown style preset." }, { status: 400 });
  }

  console.log("[STEP] Fetching Source Image");

  const imageResponse = await fetch(sourceImageUrl);
  if (!imageResponse.ok) {
    console.error(`[DEBUG] ImageKit URL download fails for URL: ${sourceImageUrl}, status: ${imageResponse.status}`);
    return NextResponse.json(
      { error: "Could not fetch the uploaded source image." },
      { status: 404 },
    );
  }

  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const imageSize = await inferImageSize(imageBuffer);

  console.log("[STEP] Image Downloaded");
  console.log("[DEBUG] Image download info:", {
    "image fetch status": imageResponse.status,
    "image fetch ok flag": imageResponse.ok,
    "image size in bytes": imageBuffer.length,
  });

  const prompt = [
    preset.prompt,
    "Do not add extra people, extra limbs, duplicate subjects, or change the overall camera angle.",
  ].join("\n\n");

  console.log("[DEBUG] Before Gemini call:", {
    model,
    sourceImageUrl,
    sourceMimeType,
    styleSlug,
    "imageBuffer.length": imageBuffer.length,
  });

  try {
    const result = await Sentry.startSpan(
      {
        name: `image edit ${model}`,
        op: "gen_ai.request",
        attributes: {
          "gen_ai.request.model": model,
          "gen_ai.operation.name": "request",
          "gen_ai.request.messages": JSON.stringify([
            { role: "user", content: prompt },
            { role: "user", content: "[source image attachment omitted]" },
          ]),
        },
      },
      async (span) => {
        let imageBase64 = "";
        let inputTokens: number | undefined = undefined;
        let outputTokens: number | undefined = undefined;
        let totalTokens: number | undefined = undefined;

        console.log("[STEP] Calling Gemini");

        try {
          if (model.includes("flash") || model.includes("gemini")) {
            // Single-step translation and style-transfer using the free gemini-2.5-flash-preview-image model
            const textResult = await generateText({
              model: geminiProvider!(model),
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `Create a styled version of the attached image.
Apply this style preset:
"${prompt}"

Do not add extra people, extra limbs, duplicate subjects, or change the overall camera angle.
Return ONLY the styled image.`,
                    },
                    {
                      type: "image",
                      image: imageBuffer,
                      mediaType: sourceMimeType,
                    },
                  ],
                },
              ],
              providerOptions: {
                google: {
                  responseModalities: ["IMAGE"],
                },
              },
            });

            console.log("[STEP] Gemini Response Received");
            console.log("[DEBUG] Gemini Response Details:", {
              "textResult.text": textResult.text,
              "textResult.files": textResult.files,
              "textResult.usage": textResult.usage,
              "finishReason": textResult.finishReason,
            });

            const generatedFile = textResult.files?.find((f) =>
              f.mediaType.startsWith("image/")
            );

            // Detect if Gemini returns text instead of image
            if (!generatedFile && textResult.text) {
              console.error(`[DEBUG] Gemini returns text instead of image. Text content: "${textResult.text}"`);
            }

            // Detect if no image file is returned
            if (!generatedFile) {
              console.error("[DEBUG] no image file is returned in textResult.files.");
              throw new Error("No image was generated by the model. Please check if your API key has access to image generation.");
            }

            imageBase64 = generatedFile.base64;
            const u = textResult.usage;
            inputTokens = u.inputTokens;
            outputTokens = u.outputTokens;
            totalTokens = u.totalTokens;
          } else {
            // Translate style instructions first
            const textResult = await generateText({
              model: geminiProvider!('gemini-2.5-flash-preview-image'),
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `Create a detailed image prompt that will generate a styled version of the attached image.
Apply this style preset:
"${prompt}"

Guidelines:
- Keep the overall composition, subjects, and camera angle of the original image.
- Describe the scene in detail with the new style elements integrated.
- Only output the prompt itself, ready to be fed to an image generator. Do not include any explanations, markdown wrapping, or introductory text.`,
                    },
                    {
                      type: "image",
                      image: imageBuffer,
                      mediaType: sourceMimeType,
                    },
                  ],
                },
              ],
            });

            console.log("[DEBUG] Gemini Text Prompt Generation Response Details:", {
              "textResult.text": textResult.text,
              "textResult.files": textResult.files,
              "textResult.usage": textResult.usage,
              "finishReason": textResult.finishReason,
            });

            const styledPrompt = textResult.text.trim();

            const out = await generateImage({
              model: geminiProvider!.image(model),
              prompt: styledPrompt,
              aspectRatio: mapSizeToAspectRatio(imageSize),
            });

            console.log("[STEP] Gemini Response Received");
            console.log("[DEBUG] Gemini Image Generation Response Details:", {
              "out.image": out.image ? { base64: `${out.image.base64.substring(0, 100)}...` } : null,
              "out.usage": out.usage,
            });

            // Detect if no image file is returned
            if (!out.image || !out.image.base64) {
              console.error("[DEBUG] no image file is returned from generateImage.");
              throw new Error("No image was returned from the image generation model.");
            }

            imageBase64 = out.image.base64;
            const u = out.usage;
            inputTokens = u.inputTokens;
            outputTokens = u.outputTokens;
            totalTokens = u.totalTokens;
          }
        } catch (geminiError: any) {
          console.error("[DEBUG] Wrap Gemini call try/catch caught an error:");
          console.error("full error object:", geminiError);
          console.error("error.message:", geminiError?.message);
          console.error("error.stack:", geminiError?.stack);
          console.error("API status code:", geminiError?.statusCode ?? geminiError?.status);
          console.error("API response body:", geminiError?.responseBody ?? geminiError?.response);
          console.error("request body sent to Gemini:", geminiError?.requestBody ?? geminiError?.request ?? {
            model,
            prompt,
            sourceMimeType,
            hasImageBuffer: !!imageBuffer
          });
          throw geminiError;
        }

        if (inputTokens != null) {
          span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
        }
        if (outputTokens != null) {
          span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
        }
        if (totalTokens != null) {
          span.setAttribute("gen_ai.usage.total_tokens", totalTokens);
        }

        span.setAttribute(
          "gen_ai.response.text",
          JSON.stringify(["[image/png generated; pixel data not sent to Sentry]"]),
        );

        return { image: { base64: imageBase64 } };
      },
    );

    // Strip data URL prefix if present in the base64 string
    const cleanBase64 = result.image.base64.includes("base64,")
      ? result.image.base64.split("base64,")[1]
      : result.image.base64;

    const imageBase64 = cleanBase64;
    const resultBuffer = Buffer.from(cleanBase64, "base64");

    console.log("[STEP] Uploading To ImageKit");

    const { url: resultImageUrl } = await uploadBufferToImageKit({
      buffer: resultBuffer,
      fileName: `${preset.slug}-result.png`,
      folder: `/users/${userId}/results`,
      mimeType: "image/png",
    });

    console.log("[STEP] Saving Generation");

    const savedGeneration = await createGeneration({
      clerkUserId: userId,
      originalFileName: typeof originalFileName === "string" ? originalFileName : null,
      sourceImageUrl,
      resultImageUrl,
      styleSlug: preset.slug,
      styleLabel: preset.label,
      model,
      promptUsed: prompt,
    });

    Sentry.logger.info("generation.completed", {
      generationId: savedGeneration.id,
      styleSlug: preset.slug,
      model,
    });

    console.log("[STEP] Request Completed");

    return NextResponse.json({
      imageBase64,
      mimeType: "image/png",
      promptUsed: prompt,
      style: { slug: preset.slug, label: preset.label },
      model,
      savedGeneration,
    });
  } catch (error: any) {
    console.error("FULL ERROR:", error);
    console.error("MESSAGE:", error?.message);
    console.error("STACK:", error?.stack);

    const isDev = process.env.NODE_ENV === "development";

    return NextResponse.json({
      error: error?.message || "An unexpected error occurred",
      ...(isDev ? {
        stack: error?.stack,
        statusCode: error?.statusCode ?? error?.status,
        responseBody: error?.responseBody ?? error?.response,
        requestBody: error?.requestBody ?? error?.request,
        errorObject: error
      } : {})
    }, { status: 500 });
  }
}