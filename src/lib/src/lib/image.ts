type ResizeOptions = {
  maxDimension?: number;
  maxPixels?: number;
  quality?: number;
  mimeType?: string;
};

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;

      if (typeof result !== 'string') {
        reject(new Error('Could not read image data.'));
        return;
      }

      resolve(result.split(',')[1] || '');
    };

    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.readAsDataURL(blob);
  });
}

async function resizeIfNeeded(
  file: Blob,
  options: ResizeOptions = {}
) {
  const {
    maxDimension = 1600,
    maxPixels = 2000000,
    quality = 0.82,
    mimeType = file.type || 'image/jpeg',
  } = options;

  const bitmap = await createImageBitmap(file);

  try {
    const scale = Math.min(
      1,
      maxDimension / Math.max(bitmap.width, bitmap.height),
      Math.sqrt(maxPixels / (bitmap.width * bitmap.height))
    );

    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('Could not prepare the image.');
    }

    context.drawImage(bitmap, 0, 0, width, height);

    const outputType = mimeType === 'image/png' ||
      mimeType === 'image/webp'
      ? mimeType
      : 'image/jpeg';

    const prepared = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        blob => blob
          ? resolve(blob)
          : reject(new Error('Image compression failed.')),
        outputType,
        quality
      );
    });

    return {
      data: await toBase64(prepared),
      mimeType: prepared.type || outputType,
    };
  } finally {
    bitmap.close();
  }
}

export const image = { resizeIfNeeded };
