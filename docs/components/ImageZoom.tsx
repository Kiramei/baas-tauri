"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

type ZoomImage = {
  alt: string;
  src: string;
};

const zoomableSelector = [
  "img.baas-screenshot",
  ".baas-doc-hero-shot img",
  ".baas-site-preview img",
].join(", ");

export function ImageZoom() {
  const [image, setImage] = useState<ZoomImage | null>(null);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const img = target.closest<HTMLImageElement>(zoomableSelector);
      if (!img) return;

      event.preventDefault();
      setImage({
        alt: img.alt,
        src: img.currentSrc || img.src,
      });
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setImage(null);
    }

    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("baas-image-zoom-open", image !== null);

    return () => {
      document.body.classList.remove("baas-image-zoom-open");
    };
  }, [image]);

  if (!image) return null;

  return (
    <div
      className="baas-image-zoom"
      role="dialog"
      aria-modal="true"
      aria-label={image.alt || "Image preview"}
      onClick={() => setImage(null)}
    >
      <button
        className="baas-image-zoom-close"
        type="button"
        aria-label="Close image preview"
        onClick={() => setImage(null)}
      >
        <X aria-hidden="true" />
      </button>
      <figure onClick={(event) => event.stopPropagation()}>
        <img src={image.src} alt={image.alt} />
        {image.alt ? <figcaption>{image.alt}</figcaption> : null}
      </figure>
    </div>
  );
}
