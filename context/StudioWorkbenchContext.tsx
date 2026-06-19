"use client";

import {
  type PropsWithChildren,
  type SubmitEvent,
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import { upload } from "@imagekit/next";
import * as Sentry from "@sentry/nextjs";

import type { GenerationQuotaSnapshot } from "@/lib/generation-quota";
import { geminiImageModels, type GeminiImageModel } from "@/lib/gemini-image-models";
import { stylePresets, type StylePreset } from "@/lib/style-presets";
import {
  GenerationHistorySummaryItem,
  GenerationResult,
  StudioWorkbenchProps,
  UploadedSource,
} from "@/lib/types";

type StudioWorkbenchContextValue = {
  error: string | null;
  file: File | null;
  history: GenerationHistorySummaryItem[];
  inputId: string;
  isGenerateDisabled: boolean;
  isLoading: boolean;
  quota: GenerationQuotaSnapshot;
  resultPreview: string | null;
  selectedModel: GeminiImageModel;
  selectedPreset: StylePreset;
  selectedStyle: string;
  sourcePreview: string | null;
  viewedHistoryItem: GenerationHistorySummaryItem | null;
  closeHistoryPreview: () => void;
  handleSubmit: (event: SubmitEvent<HTMLFormElement>) => Promise<void>;
  openHistoryPreview: (item: GenerationHistorySummaryItem) => void;
  replaceFile: (nextFile: File | null) => void;
  selectModel: (model: GeminiImageModel) => void;
  selectStyle: (styleSlug: string) => void;
};

const StudioWorkbenchContext = createContext<StudioWorkbenchContextValue | null>(null);

const uploadInputId = "studio-image-upload";

async function getImageKitAuthParams() {
  const response = await fetch("/api/upload");

  if (!response.ok) {
    throw new Error("Failed to get upload credentials.");
  }

  const data = (await response.json()) as {
    token: string;
    expire: number;
    signature: string;
    publicKey: string;
  };

  return data;
}

export function StudioWorkbenchProvider({
  children,
  clerkUserId,
  initialHistory,
  initialQuota,
}: PropsWithChildren<StudioWorkbenchProps>) {
  const value = useStudioWorkbenchValue({ clerkUserId, initialHistory, initialQuota });

  return (
    <StudioWorkbenchContext.Provider value={value}>{children}</StudioWorkbenchContext.Provider>
  );
}

export function useStudioWorkbench() {
  const value = useContext(StudioWorkbenchContext);

  if (!value) {
    throw new Error("useStudioWorkbench must be used within StudioWorkbenchProvider.");
  }

  return value;
}

function useStudioWorkbenchValue({
  clerkUserId,
  initialHistory,
  initialQuota,
}: StudioWorkbenchProps): StudioWorkbenchContextValue {
  const [selectedStyle, setSelectedStyle] = useState(stylePresets[0]?.slug ?? "");
  const [selectedModel, setSelectedModel] = useState<GeminiImageModel>(geminiImageModels[0]);
  const [file, setFile] = useState<File | null>(null);
  const [uploadedSource, setUploadedSource] = useState<UploadedSource | null>(null);
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [history, setHistory] = useState(initialHistory);
  const [viewedHistoryItem, setViewedHistoryItem] = useState<GenerationHistorySummaryItem | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [quota, setQuota] = useState<GenerationQuotaSnapshot>(initialQuota);

  // this will create a preview of the image when the file is uploaded
  useEffect(() => {
    if (!file) {
      setSourcePreview(null);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setSourcePreview(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const resultPreview = result ? `data:${result.mimeType};base64,${result.imageBase64}` : null;
  const selectedPreset =
    stylePresets.find((preset) => preset.slug === selectedStyle) ?? stylePresets[0];
  const isGenerateDisabled = isLoading || !file || quota.remaining <= 0;

  function resetGenerationState() {
    setResult(null);
    setError(null);
  }

  function replaceFile(nextFile: File | null) {
    setFile(nextFile);
    setUploadedSource(null);
    resetGenerationState();
  }

  function openHistoryPreview(item: GenerationHistorySummaryItem) {
    setViewedHistoryItem(item);
    setError(null);
  }

  function closeHistoryPreview() {
    setViewedHistoryItem(null);
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!file) {
      setError("Please upload an image first.");
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      let nextUploadedSource = uploadedSource;

      if (!nextUploadedSource) {
        const authParams = await getImageKitAuthParams();

        const uploadResult = await upload({
          file,
          fileName: file.name,
          folder: `/users/${clerkUserId}/uploads`,
          signature: authParams.signature,
          token: authParams.token,
          expire: authParams.expire,
          publicKey: authParams.publicKey,
        });

        if (!uploadResult.url) {
          throw new Error("Upload did not return a URL.");
        }

        nextUploadedSource = {
          imageUrl: uploadResult.url,
          originalFileName: file.name,
          sourceMimeType: file.type,
        };

        setUploadedSource(nextUploadedSource);
      }

      const payloadToSend = {
        sourceImageUrl: nextUploadedSource.imageUrl,
        sourceMimeType: nextUploadedSource.sourceMimeType,
        originalFileName: nextUploadedSource.originalFileName,
        styleSlug: selectedStyle,
        model: selectedModel,
      };
      console.log("[DEBUG] Frontend payload about to be sent:", JSON.stringify(payloadToSend, null, 2));

      const response = await fetch("/api/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadToSend),
      });

      const payload = (await response.json()) as GenerationResult;

      if (!response.ok) {
        setResult(null);
        const err = (payload as { error?: string }).error;
        setError(typeof err === "string" ? err : "Generation failed.");
        const p = payload as { limit?: number; used?: number };
        if (typeof p.limit === "number" && typeof p.used === "number") {
          setQuota({
            limit: p.limit,
            used: p.used,
            remaining: Math.max(0, p.limit - p.used),
          });
        }
        return;
      }

      const resultPayload = payload as GenerationResult;
      const g = resultPayload.savedGeneration;

      Sentry.logger.info("studio.generation_succeeded", {
        styleSlug: g.styleSlug,
        model: g.model,
      });

      setResult(resultPayload);
      setHistory((current) => [g, ...current.filter((item) => item.id !== g.id)]);
      setQuota((prev) => ({
        limit: prev.limit,
        used: prev.used + 1,
        remaining: Math.max(0, prev.remaining - 1),
      }));
    } catch {
      setResult(null);
      setError("Something went wrong while generating the image.");
    } finally {
      setIsLoading(false);
    }
  }

  return {
    closeHistoryPreview,
    error,
    file,
    handleSubmit,
    history,
    inputId: uploadInputId,
    isGenerateDisabled,
    isLoading,
    openHistoryPreview,
    quota,
    replaceFile,
    resultPreview,
    selectedModel,
    selectedPreset,
    selectedStyle,
    selectModel: setSelectedModel,
    selectStyle: setSelectedStyle,
    sourcePreview,
    viewedHistoryItem,
  };
}