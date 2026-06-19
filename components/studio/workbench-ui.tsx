import Image from "next/image";
import { CheckIcon, DownloadIcon, Loader2Icon, WandSparklesIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, downloadImageFromUrl } from "@/lib/utils";
import { GenerationHistorySummaryItem } from "@/lib/types";

const previewFrameClassName =
  "relative mt-5 aspect-[0.82] overflow-hidden rounded-[1.45rem] bg-background/28";

export function GenerateButton({ disabled, isLoading }: { disabled: boolean; isLoading: boolean }) {
  return (
    <Button
      type="submit"
      disabled={disabled}
      className={cn("studio-primary-action rounded-full w-full py-5 mt-2 text-2xl")}
    >
      {isLoading ? (
        <>
          <Loader2Icon className="animate-spin size-5" /> Generating
        </>
      ) : (
        <>
          <WandSparklesIcon className="size-5" /> Generate
        </>
      )}
    </Button>
  );
}

export function StylePresetCard({
  isSelected,
  label,
  onSelect,
  thumbnailAlt,
  thumbnailPath,
}: {
  isSelected: boolean;
  label: string;
  onSelect: () => void;
  thumbnailAlt: string;
  thumbnailPath: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "studio-panel-inset group relative overflow-hidden rounded-[1.85rem] border text-left",
        isSelected ? "studio-preset-card-selected" : "studio-preset-card",
      )}
    >
      <div className="relative aspect-[0.92] overflow-hidden bg-background/25">
        <Image
          src={thumbnailPath}
          alt={thumbnailAlt}
          fill
          className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />

        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background via-background/50 to-transparent" />

        {isSelected ? (
          <div className="studio-primary-action absolute right-3 top-3 flex size-10 items-center justify-center rounded-full text-primary-foreground">
            <CheckIcon className="size-5" />
          </div>
        ) : null}

        <div className="absolute inset-x-0 bottom-0 px-5 pb-5 pt-8">
          <p className="text-[1.05rem] font-semibold text-primary-foreground drop-shadow-[0_2px_12px_rgba(0,0,0,0.5)] sm:text-[1.15rem]">
            {label}
          </p>
        </div>
      </div>
    </button>
  );
}

export function PreviewFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <>
      <p className="caps-xl text-xs font-semibold uppercase text-muted-foreground">{label}</p>
      <div className={previewFrameClassName}>{children}</div>
    </>
  );
}

export function ResultPreviewFrame({
  fallbackAlt,
  fallbackSrc,
  isLoading,
  resultPreview,
}: {
  fallbackAlt: string;
  fallbackSrc: string;
  isLoading: boolean;
  resultPreview: string | null;
}) {
  if (isLoading) {
    return (
      <div className="flex h-full flex-col justify-between p-4">
        <Skeleton className="h-full w-full rounded-[1rem]" />
        <div className="mt-4 flex items-center justify-center gap-3 pb-2 text-lg text-muted-foreground">
          <Loader2Icon className="size-5 animate-spin text-primary" />
          Generating...
        </div>
      </div>
    );
  }

  if (resultPreview) {
    return (
      <Image
        src={resultPreview}
        alt="Generated styled result"
        fill
        unoptimized
        className="object-cover"
      />
    );
  }

  return <Image src={fallbackSrc} alt={fallbackAlt} fill className="object-cover" />;
}

export function HistoryCard({
  item,
  onView,
}: {
  item: GenerationHistorySummaryItem;
  onView: () => void;
}) {
  return (
    <div className="studio-panel-inset studio-history-card overflow-hidden rounded-[1.45rem] border">
      <div className="relative aspect-[1.1] overflow-hidden bg-background/20">
        <Image
          src={item.resultImageUrl}
          alt={`${item.styleLabel} history preview`}
          fill
          unoptimized
          className="object-cover"
        />
        <div className="absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-background via-background/55 to-transparent" />
      </div>

      <div className="flex items-center gap-2 px-4 py-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="studio-pill flex-1 rounded-full px-3 py-2 text-xs"
          onClick={onView}
        >
          View
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="studio-pill rounded-full px-3 py-2 text-xs"
          aria-label="Download result"
          onClick={() => {
            void downloadImageFromUrl(item.resultImageUrl, `${item.styleSlug}-result.png`);
          }}
        >
          <DownloadIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}