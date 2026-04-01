/**
 * Generates an HTML page that uses PDF.js to render a PDF from a base64 string,
 * with built-in annotation support (highlight, freehand draw, text notes).
 *
 * Communication with React Native happens via window.ReactNativeWebView.postMessage
 * and the WebView's injectedJavaScript / onMessage props.
 */
export function getPdfViewerHtml(base64Data) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes" />
  <title>PDF Viewer</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #525659;
      overflow-x: hidden;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }
    #pdf-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 8px 0;
      gap: 8px;
    }
    .page-wrapper {
      position: relative;
      background: white;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      margin: 0 auto;
    }
    .page-wrapper canvas {
      display: block;
      width: 100%;
      height: auto;
    }
    /* Annotation overlay on each page */
    .annotation-layer {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
    }
    .annotation-layer.active {
      pointer-events: auto;
      cursor: crosshair;
    }
    /* Highlight rectangles */
    .highlight-rect {
      position: absolute;
      background: rgba(255, 235, 59, 0.4);
      border: 1px solid rgba(255, 193, 7, 0.6);
      pointer-events: auto;
      cursor: pointer;
    }
    .highlight-rect:hover {
      background: rgba(255, 235, 59, 0.6);
    }
    /* Text notes */
    .text-note {
      position: absolute;
      background: #fff9c4;
      border: 1px solid #f9a825;
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 12px;
      color: #333;
      max-width: 200px;
      word-wrap: break-word;
      pointer-events: auto;
      cursor: move;
      box-shadow: 0 1px 4px rgba(0,0,0,0.2);
    }
    /* Freehand drawing canvas */
    .draw-canvas {
      position: absolute;
      top: 0; left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .draw-canvas.active {
      pointer-events: auto;
      cursor: crosshair;
    }
    /* Page number label */
    .page-label {
      text-align: center;
      color: #aaa;
      font-size: 11px;
      padding: 2px 0;
    }
    #loading {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      color: white;
      font-size: 16px;
    }
    #error-msg {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      color: #ff5252;
      font-size: 14px;
      text-align: center;
      padding: 20px;
      display: none;
    }
  </style>
</head>
<body>
  <div id="loading">Loading PDF...</div>
  <div id="error-msg"></div>
  <div id="pdf-container"></div>

  <script>
    // ---- State ----
    let currentMode = 'view'; // 'view' | 'highlight' | 'draw' | 'text'
    let drawColor = '#FF0000';
    let drawWidth = 3;
    let highlightColor = 'rgba(255, 235, 59, 0.4)';
    let annotations = {}; // pageNum -> { highlights: [], drawings: [], notes: [] }
    let pdfDoc = null;
    let totalPages = 0;

    // ---- PDF.js setup ----
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    async function loadPdf() {
      try {
        const base64 = "${base64Data}";
        const raw = atob(base64);
        const uint8 = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) uint8[i] = raw.charCodeAt(i);

        pdfDoc = await pdfjsLib.getDocument({ data: uint8 }).promise;
        totalPages = pdfDoc.numPages;
        document.getElementById('loading').style.display = 'none';

        sendMessage({ type: 'pdfLoaded', totalPages });

        for (let p = 1; p <= totalPages; p++) {
          await renderPage(p);
        }
      } catch (err) {
        document.getElementById('loading').style.display = 'none';
        const el = document.getElementById('error-msg');
        el.textContent = 'Failed to load PDF: ' + err.message;
        el.style.display = 'block';
        sendMessage({ type: 'error', message: err.message });
      }
    }

    async function renderPage(pageNum) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2 });

      // Wrapper
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.dataset.page = pageNum;
      wrapper.style.width = viewport.width / 2 + 'px';
      wrapper.style.height = viewport.height / 2 + 'px';

      // Canvas for PDF content
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      wrapper.appendChild(canvas);

      // Draw canvas for freehand
      const drawCanvas = document.createElement('canvas');
      drawCanvas.className = 'draw-canvas';
      drawCanvas.width = viewport.width;
      drawCanvas.height = viewport.height;
      drawCanvas.dataset.page = pageNum;
      wrapper.appendChild(drawCanvas);
      setupDrawCanvas(drawCanvas, pageNum);

      // Annotation overlay div
      const overlay = document.createElement('div');
      overlay.className = 'annotation-layer';
      overlay.dataset.page = pageNum;
      wrapper.appendChild(overlay);
      setupAnnotationLayer(overlay, pageNum);

      // Page label
      const label = document.createElement('div');
      label.className = 'page-label';
      label.textContent = 'Page ' + pageNum + ' of ' + totalPages;

      const container = document.getElementById('pdf-container');
      container.appendChild(wrapper);
      container.appendChild(label);

      // Init annotations for page
      if (!annotations[pageNum]) {
        annotations[pageNum] = { highlights: [], drawings: [], notes: [] };
      }
    }

    // ---- Helper to get coordinates from touch or mouse event ----
    function getEventCoords(e) {
      if (e.touches && e.touches.length > 0) {
        return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
      }
      if (e.changedTouches && e.changedTouches.length > 0) {
        return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
      }
      return { clientX: e.clientX, clientY: e.clientY };
    }

    // ---- Highlight logic ----
    function setupAnnotationLayer(overlay, pageNum) {
      let startX, startY, rect;

      function onDown(e) {
        if (currentMode !== 'highlight' && currentMode !== 'text') return;
        e.preventDefault();
        e.stopPropagation();
        const coords = getEventCoords(e);
        const bounds = overlay.getBoundingClientRect();
        const x = coords.clientX - bounds.left;
        const y = coords.clientY - bounds.top;

        if (currentMode === 'highlight') {
          startX = x;
          startY = y;
          rect = document.createElement('div');
          rect.className = 'highlight-rect';
          rect.style.left = startX + 'px';
          rect.style.top = startY + 'px';
          rect.style.width = '0px';
          rect.style.height = '0px';
          rect.style.background = highlightColor;
          overlay.appendChild(rect);
        } else if (currentMode === 'text') {
          promptTextNote(overlay, pageNum, x, y);
        }
      }

      function onMove(e) {
        if (currentMode === 'highlight' && rect) {
          e.preventDefault();
          e.stopPropagation();
          const coords = getEventCoords(e);
          const bounds = overlay.getBoundingClientRect();
          const curX = coords.clientX - bounds.left;
          const curY = coords.clientY - bounds.top;
          rect.style.left = Math.min(startX, curX) + 'px';
          rect.style.top = Math.min(startY, curY) + 'px';
          rect.style.width = Math.abs(curX - startX) + 'px';
          rect.style.height = Math.abs(curY - startY) + 'px';
        }
      }

      function onUp(e) {
        if (currentMode === 'highlight' && rect) {
          const w = parseInt(rect.style.width) || 0;
          const h = parseInt(rect.style.height) || 0;
          if (w < 5 && h < 5) {
            overlay.removeChild(rect);
          } else {
            // Add delete on long-press (since dblclick is unreliable on mobile)
            let pressTimer;
            rect.addEventListener('touchstart', function() {
              pressTimer = setTimeout(() => {
                overlay.removeChild(rect);
                sendMessage({ type: 'annotationRemoved', page: pageNum });
              }, 800);
            });
            rect.addEventListener('touchend', function() { clearTimeout(pressTimer); });
            rect.addEventListener('dblclick', () => {
              overlay.removeChild(rect);
              sendMessage({ type: 'annotationRemoved', page: pageNum });
            });
            annotations[pageNum].highlights.push({
              left: rect.style.left,
              top: rect.style.top,
              width: rect.style.width,
              height: rect.style.height
            });
            sendMessage({ type: 'highlightAdded', page: pageNum });
          }
          rect = null;
        }
      }

      // Touch events (primary for mobile)
      overlay.addEventListener('touchstart', onDown, { passive: false });
      overlay.addEventListener('touchmove', onMove, { passive: false });
      overlay.addEventListener('touchend', onUp);
      // Mouse events (fallback)
      overlay.addEventListener('mousedown', onDown);
      overlay.addEventListener('mousemove', onMove);
      overlay.addEventListener('mouseup', onUp);
    }

    function promptTextNote(overlay, pageNum, x, y) {
      // Send message to RN to get text input
      sendMessage({ type: 'requestTextInput', page: pageNum, x, y });
    }

    function addTextNote(pageNum, x, y, text) {
      const overlays = document.querySelectorAll('.annotation-layer[data-page="' + pageNum + '"]');
      if (!overlays.length) return;
      const overlay = overlays[0];
      const note = document.createElement('div');
      note.className = 'text-note';
      note.style.left = x + 'px';
      note.style.top = y + 'px';
      note.textContent = text;
      note.addEventListener('dblclick', () => {
        overlay.removeChild(note);
        sendMessage({ type: 'annotationRemoved', page: pageNum });
      });
      overlay.appendChild(note);
      annotations[pageNum].notes.push({ x, y, text });
      sendMessage({ type: 'noteAdded', page: pageNum });
    }

    // ---- Freehand drawing ----
    function setupDrawCanvas(canvas, pageNum) {
      const ctx = canvas.getContext('2d');
      let drawing = false;
      let lastX, lastY;

      function onDrawStart(e) {
        if (currentMode !== 'draw') return;
        e.preventDefault();
        e.stopPropagation();
        drawing = true;
        const coords = getEventCoords(e);
        const bounds = canvas.getBoundingClientRect();
        const scaleX = canvas.width / bounds.width;
        const scaleY = canvas.height / bounds.height;
        lastX = (coords.clientX - bounds.left) * scaleX;
        lastY = (coords.clientY - bounds.top) * scaleY;
      }

      function onDrawMove(e) {
        if (!drawing || currentMode !== 'draw') return;
        e.preventDefault();
        e.stopPropagation();
        const coords = getEventCoords(e);
        const bounds = canvas.getBoundingClientRect();
        const scaleX = canvas.width / bounds.width;
        const scaleY = canvas.height / bounds.height;
        const x = (coords.clientX - bounds.left) * scaleX;
        const y = (coords.clientY - bounds.top) * scaleY;
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
        ctx.strokeStyle = drawColor;
        ctx.lineWidth = drawWidth * 2;
        ctx.lineCap = 'round';
        ctx.stroke();
        lastX = x;
        lastY = y;
      }

      function onDrawEnd() {
        if (drawing) {
          drawing = false;
          sendMessage({ type: 'drawingAdded', page: pageNum });
        }
      }

      // Touch events (primary for mobile)
      canvas.addEventListener('touchstart', onDrawStart, { passive: false });
      canvas.addEventListener('touchmove', onDrawMove, { passive: false });
      canvas.addEventListener('touchend', onDrawEnd);
      // Mouse events (fallback)
      canvas.addEventListener('mousedown', onDrawStart);
      canvas.addEventListener('mousemove', onDrawMove);
      canvas.addEventListener('mouseup', onDrawEnd);
    }

    // ---- Mode switching (called from RN) ----
    function setMode(mode) {
      currentMode = mode;
      document.querySelectorAll('.annotation-layer').forEach(el => {
        el.classList.toggle('active', mode === 'highlight' || mode === 'text');
      });
      document.querySelectorAll('.draw-canvas').forEach(el => {
        el.classList.toggle('active', mode === 'draw');
      });
      sendMessage({ type: 'modeChanged', mode });
    }

    function setDrawColor(color) {
      drawColor = color;
    }

    function setHighlightColor(color) {
      highlightColor = color;
    }

    function clearAnnotations(pageNum) {
      // Clear highlights and notes
      const overlay = document.querySelector('.annotation-layer[data-page="' + pageNum + '"]');
      if (overlay) {
        overlay.querySelectorAll('.highlight-rect, .text-note').forEach(el => el.remove());
      }
      // Clear drawings
      const drawCanvas = document.querySelector('.draw-canvas[data-page="' + pageNum + '"]');
      if (drawCanvas) {
        const ctx = drawCanvas.getContext('2d');
        ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      }
      if (annotations[pageNum]) {
        annotations[pageNum] = { highlights: [], drawings: [], notes: [] };
      }
      sendMessage({ type: 'annotationsCleared', page: pageNum });
    }

    function clearAllAnnotations() {
      for (let p = 1; p <= totalPages; p++) clearAnnotations(p);
    }

    // ---- Communication ----
    function sendMessage(data) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(data));
      }
    }

    // Listen for commands from React Native
    window.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        switch (msg.command) {
          case 'setMode': setMode(msg.mode); break;
          case 'setDrawColor': setDrawColor(msg.color); break;
          case 'setHighlightColor': setHighlightColor(msg.color); break;
          case 'addTextNote': addTextNote(msg.page, msg.x, msg.y, msg.text); break;
          case 'clearPage': clearAnnotations(msg.page); break;
          case 'clearAll': clearAllAnnotations(); break;
        }
      } catch (_) {}
    });

    // Start
    loadPdf();
  </script>
</body>
</html>
  `.trim();
}
