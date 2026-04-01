export function getPdfConverterHtml(base64Data, options = {}) {
  const format = JSON.stringify(options.format || 'txt');
  const fileName = JSON.stringify(options.fileName || 'document.txt');
  const mimeType = JSON.stringify(options.mimeType || 'text/plain');
  const extraScripts =
    options.format === 'docx'
      ? '<script src="https://unpkg.com/docx@9.5.1/dist/index.umd.cjs"></script>'
      : options.format === 'pptx'
        ? '<script src="https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js"></script>'
        : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
  />
  <title>PDF Converter</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  ${extraScripts}
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: #0f172a;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #status {
      font-size: 14px;
      line-height: 1.5;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="status">Preparing conversion...</div>

  <script>
    const sourceBase64 = "${base64Data}";
    const outputFormat = ${format};
    const outputFileName = ${fileName};
    const outputMimeType = ${mimeType};

    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    function sendMessage(payload) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    }

    function sendStatus(message) {
      document.getElementById('status').textContent = message;
      sendMessage({
        type: 'conversionStatus',
        message,
      });
    }

    function sendError(message) {
      sendMessage({
        type: 'conversionError',
        message,
      });
    }

    function bytesToBase64(bytes) {
      let binary = '';
      const chunkSize = 0x8000;

      for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode.apply(null, Array.from(chunk));
      }

      return btoa(binary);
    }

    function encodeTextBase64(text) {
      return bytesToBase64(new TextEncoder().encode(text));
    }

    function dataUrlToBase64(dataUrl) {
      return String(dataUrl || '').split(',')[1] || '';
    }

    function base64ToUint8Array(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function chunkAndSend(base64Payload) {
      const chunkSize = 120000;
      const totalChunks = Math.max(1, Math.ceil(base64Payload.length / chunkSize));

      sendMessage({
        type: 'conversionMeta',
        fileName: outputFileName,
        mimeType: outputMimeType,
        totalChunks,
      });

      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * chunkSize;
        const end = start + chunkSize;
        sendMessage({
          type: 'conversionChunk',
          index,
          chunk: base64Payload.slice(start, end),
        });
      }

      sendMessage({
        type: 'conversionComplete',
      });
    }

    function normalizePageText(text) {
      const trimmed = String(text || '').trim();
      return trimmed || '[No text found on this page.]';
    }

    function fitWithin(width, height, maxWidth, maxHeight) {
      if (!width || !height) {
        return { width: maxWidth, height: maxHeight };
      }

      const scale = Math.min(maxWidth / width, maxHeight / height, 1);
      return {
        width: Math.max(width * scale, 1),
        height: Math.max(height * scale, 1),
      };
    }

    function extractTextFromItems(items) {
      if (!Array.isArray(items) || !items.length) {
        return '';
      }

      const lines = [];
      let currentLine = '';
      let lastY = null;

      items.forEach((item) => {
        const segment = String(item.str || '').replace(/\\s+/g, ' ').trim();
        const transformY = item.transform && item.transform.length > 5
          ? Number(item.transform[5])
          : lastY;
        const shouldBreak =
          currentLine &&
          ((typeof item.hasEOL === 'boolean' && item.hasEOL) ||
            (lastY !== null &&
              transformY !== null &&
              Math.abs(transformY - lastY) > 4));

        if (shouldBreak) {
          lines.push(currentLine.trim());
          currentLine = '';
        }

        if (segment) {
          currentLine = currentLine ? currentLine + ' ' + segment : segment;
        }

        lastY = transformY;
      });

      if (currentLine.trim()) {
        lines.push(currentLine.trim());
      }

      return lines.join('\\n').trim();
    }

    async function extractPdfPages() {
      sendStatus('Reading PDF...');

      const raw = atob(sourceBase64);
      const uint8 = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) {
        uint8[index] = raw.charCodeAt(index);
      }

      const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
      const pages = [];
      const requiresPageImages =
        outputFormat === 'docx' ||
        outputFormat === 'pptx' ||
        outputFormat === 'html';

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        sendStatus('Extracting text from page ' + pageNumber + ' of ' + pdf.numPages + '...');
        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const pageText = extractTextFromItems(textContent.items);
        const pageEntry = {
          text: pageText,
          imageDataUrl: null,
          width: 0,
          height: 0,
        };

        if (requiresPageImages) {
          sendStatus('Rendering page ' + pageNumber + ' of ' + pdf.numPages + '...');
          const baseViewport = page.getViewport({ scale: 1 });
          const targetWidth = Math.min(Math.max(baseViewport.width * 1.7, 900), 1400);
          const renderScale = targetWidth / baseViewport.width;
          const viewport = page.getViewport({ scale: renderScale });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d', { alpha: false });
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          context.fillStyle = '#FFFFFF';
          context.fillRect(0, 0, canvas.width, canvas.height);

          await page.render({
            canvasContext: context,
            viewport,
          }).promise;

          pageEntry.imageDataUrl = canvas.toDataURL('image/png');
          pageEntry.width = canvas.width;
          pageEntry.height = canvas.height;
        }

        pages.push(pageEntry);
      }

      return pages;
    }

    function buildTxtBase64(pages) {
      const content = pages
        .map((page, index) => 'Page ' + (index + 1) + '\\n' + normalizePageText(page.text))
        .join('\\n\\n');
      return encodeTextBase64(content);
    }

    function buildMarkdownBase64(pages) {
      const content = pages
        .map((page, index) => '# Page ' + (index + 1) + '\\n\\n' + normalizePageText(page.text))
        .join('\\n\\n');
      return encodeTextBase64(content);
    }

    function buildHtmlBase64(pages) {
      const sections = pages
        .map((page, index) => {
          const imageMarkup = page.imageDataUrl
            ? '<img src="' +
              page.imageDataUrl +
              '" alt="Page ' +
              (index + 1) +
              '" style="display:block; width:100%; height:auto; border:1px solid #d7dde6; box-shadow:0 6px 18px rgba(15, 23, 42, 0.08);" />'
            : '<p style="white-space: normal; line-height: 1.6; font-size: 14px;">' +
              escapeHtml(normalizePageText(page.text)).replace(/\\n/g, '<br />') +
              '</p>';
          return (
            '<section style="page-break-after: always; margin: 0 auto 32px; max-width: 960px;">' +
            '<h1 style="font-size: 26px; margin-bottom: 16px;">Page ' +
            (index + 1) +
            '</h1>' +
            imageMarkup +
            '</section>'
          );
        })
        .join('');

      const html =
        '<!DOCTYPE html><html><head><meta charset="UTF-8" />' +
        '<title>' +
        escapeHtml(outputFileName) +
        '</title></head><body style="font-family: Arial, sans-serif; color: #222; padding: 24px;">' +
        sections +
        '</body></html>';

      return encodeTextBase64(html);
    }

    async function buildDocxBase64(pages) {
      if (!window.docx) {
        throw new Error('Word conversion library failed to load.');
      }

      const children = [];
      const maxWidth = 520;
      const maxHeight = 760;

      pages.forEach((page, index) => {
        if (!page.imageDataUrl) {
          throw new Error('Page image rendering failed for Word conversion.');
        }

        const fittedSize = fitWithin(page.width, page.height, maxWidth, maxHeight);
        children.push(
          new window.docx.Paragraph({
            pageBreakBefore: index > 0,
            alignment: window.docx.AlignmentType.CENTER,
            children: [
              new window.docx.ImageRun({
                data: base64ToUint8Array(dataUrlToBase64(page.imageDataUrl)),
                type: 'png',
                transformation: {
                  width: Math.round(fittedSize.width),
                  height: Math.round(fittedSize.height),
                },
              }),
            ],
          })
        );
      });

      const document = new window.docx.Document({
        sections: [
          {
            properties: {},
            children,
          },
        ],
      });

      return window.docx.Packer.toBase64String(document);
    }

    async function buildPptxBase64(pages) {
      if (!window.PptxGenJS) {
        throw new Error('PowerPoint conversion library failed to load.');
      }

      const pptx = new window.PptxGenJS();
      pptx.layout = 'LAYOUT_WIDE';
      pptx.author = 'Expo Doc Viewer';
      pptx.company = 'Expo Doc Viewer';
      pptx.subject = 'Converted from PDF';
      pptx.title = outputFileName;
      const slideWidth = 13.333;
      const slideHeight = 7.5;
      const horizontalMargin = 0.35;
      const verticalMargin = 0.25;

      pages.forEach((page, index) => {
        if (!page.imageDataUrl) {
          throw new Error('Page image rendering failed for PowerPoint conversion.');
        }

        const slide = pptx.addSlide();
        slide.background = { color: 'FFFFFF' };
        const fittedSize = fitWithin(
          page.width,
          page.height,
          slideWidth - horizontalMargin * 2,
          slideHeight - verticalMargin * 2
        );
        slide.addImage({
          data: page.imageDataUrl,
          x: (slideWidth - fittedSize.width) / 2,
          y: (slideHeight - fittedSize.height) / 2,
          w: fittedSize.width,
          h: fittedSize.height,
        });
      });

      return pptx.write({
        outputType: 'base64',
        compression: true,
      });
    }

    async function runConversion() {
      try {
        const pages = await extractPdfPages();
        let resultBase64 = '';

        if (outputFormat === 'txt') {
          sendStatus('Building text document...');
          resultBase64 = buildTxtBase64(pages);
        } else if (outputFormat === 'md') {
          sendStatus('Building Markdown document...');
          resultBase64 = buildMarkdownBase64(pages);
        } else if (outputFormat === 'html') {
          sendStatus('Building image-based HTML document...');
          resultBase64 = buildHtmlBase64(pages);
        } else if (outputFormat === 'docx') {
          sendStatus('Building image-based Word document...');
          resultBase64 = await buildDocxBase64(pages);
        } else if (outputFormat === 'pptx') {
          sendStatus('Building image-based PowerPoint presentation...');
          resultBase64 = await buildPptxBase64(pages);
        } else {
          throw new Error('Unsupported conversion format: ' + outputFormat);
        }

        sendStatus('Finishing conversion...');
        chunkAndSend(resultBase64);
      } catch (error) {
        sendError(error && error.message ? error.message : 'Conversion failed.');
      }
    }

    window.addEventListener(
      'error',
      function(event) {
        if (event && event.target && event.target.src) {
          sendError('Failed to load conversion script: ' + event.target.src);
        }
      },
      true
    );

    runConversion();
  </script>
</body>
</html>
  `.trim();
}
