import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import { WebView } from 'react-native-webview';
import { getPdfViewerHtml } from './src/utils/pdfViewerHtml';

const TOOLS = [
  { id: 'view', label: '👆 Select' },
  { id: 'highlight', label: '🖍 Highlight' },
  { id: 'draw', label: '✏️ Draw' },
  { id: 'text', label: '📝 Note' },
];

const COLORS = [
  { name: 'Red', value: '#FF0000' },
  { name: 'Blue', value: '#2196F3' },
  { name: 'Green', value: '#4CAF50' },
  { name: 'Orange', value: '#FF9800' },
  { name: 'Purple', value: '#9C27B0' },
];

const DEFAULT_COLOR = COLORS[0].value;
const HIGHLIGHT_ALPHA_HEX = '66';
const ANNOTATION_STORAGE_DIR = `${Paths.document.uri}annotation-state/`;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAnnotationState(rawAnnotations) {
  if (!rawAnnotations || typeof rawAnnotations !== 'object') {
    return {};
  }

  return Object.entries(rawAnnotations).reduce((pages, [pageKey, pageAnnotations]) => {
    if (!pageAnnotations || typeof pageAnnotations !== 'object') {
      return pages;
    }

    pages[pageKey] = {
      highlights: Array.isArray(pageAnnotations.highlights)
        ? pageAnnotations.highlights
        : [],
      drawings: Array.isArray(pageAnnotations.drawings)
        ? pageAnnotations.drawings
        : [],
      notes: Array.isArray(pageAnnotations.notes) ? pageAnnotations.notes : [],
    };

    return pages;
  }, {});
}

function hasAnnotations(annotationState = {}) {
  return Object.values(annotationState).some((pageAnnotations) => {
    if (!pageAnnotations || typeof pageAnnotations !== 'object') {
      return false;
    }

    return (
      (pageAnnotations.highlights || []).length > 0 ||
      (pageAnnotations.drawings || []).length > 0 ||
      (pageAnnotations.notes || []).length > 0
    );
  });
}

function getAnnotationStorageUri(documentKey) {
  return `${ANNOTATION_STORAGE_DIR}${documentKey}.json`;
}

function sanitizeFileSegment(value = 'document') {
  return (
    value
      .replace(/\.pdf$/i, '')
      .replace(/[^a-z0-9-_]+/gi, '_')
      .replace(/^_+|_+$/g, '') || 'document'
  );
}

function buildAnnotatedFileName(documentName) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  return `${sanitizeFileSegment(documentName)}_annotated_${timestamp}.pdf`;
}

function parseHexColor(hexColor, fallbackOpacity = 1) {
  if (typeof hexColor !== 'string' || !hexColor.startsWith('#')) {
    return { color: rgb(1, 0, 0), opacity: fallbackOpacity };
  }

  let normalized = hexColor.slice(1);
  if (normalized.length === 3 || normalized.length === 4) {
    normalized = normalized
      .split('')
      .map((character) => character + character)
      .join('');
  }

  let opacity = fallbackOpacity;
  if (normalized.length === 8) {
    opacity = parseInt(normalized.slice(6, 8), 16) / 255;
    normalized = normalized.slice(0, 6);
  }

  if (normalized.length !== 6) {
    return { color: rgb(1, 0, 0), opacity: fallbackOpacity };
  }

  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);

  if ([red, green, blue].some((channel) => Number.isNaN(channel))) {
    return { color: rgb(1, 0, 0), opacity: fallbackOpacity };
  }

  return {
    color: rgb(red / 255, green / 255, blue / 255),
    opacity,
  };
}

function normalizePdfPoint(point, pageWidth, pageHeight) {
  return {
    x: clamp(Number(point?.x) || 0, 0, 1) * pageWidth,
    y: pageHeight - clamp(Number(point?.y) || 0, 0, 1) * pageHeight,
  };
}

function wrapNoteText(text, font, fontSize, maxWidth) {
  const paragraphs = String(text || '').split(/\r?\n/);
  const lines = [];

  const pushWrappedWord = (word) => {
    let fragment = '';
    for (const character of word) {
      const candidate = fragment + character;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        fragment = candidate;
      } else {
        if (fragment) {
          lines.push(fragment);
        }
        fragment = character;
      }
    }

    if (fragment) {
      lines.push(fragment);
    }
  };

  paragraphs.forEach((paragraph) => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);

    if (!words.length) {
      lines.push('');
      return;
    }

    let currentLine = '';

    for (const word of words) {
      if (!currentLine) {
        if (font.widthOfTextAtSize(word, fontSize) > maxWidth) {
          pushWrappedWord(word);
          continue;
        }

        currentLine = word;
        continue;
      }

      const nextLine = `${currentLine} ${word}`;

      if (font.widthOfTextAtSize(nextLine, fontSize) <= maxWidth) {
        currentLine = nextLine;
        continue;
      }

      if (font.widthOfTextAtSize(word, fontSize) > maxWidth) {
        lines.push(currentLine);
        currentLine = '';
        pushWrappedWord(word);
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  });

  return lines.length ? lines : [''];
}

function getSelectedAnnotationDescription(selectedAnnotation) {
  if (!selectedAnnotation) {
    return 'Tap any highlight, drawing, or note to select it.';
  }

  const label =
    selectedAnnotation.type === 'highlight'
      ? 'highlight'
      : selectedAnnotation.type === 'drawing'
        ? 'drawing'
        : 'note';

  return `Selected ${label} on page ${selectedAnnotation.page}.`;
}

async function savePdfToAndroidDeviceFolder(base64Contents, fileName) {
  if (
    Platform.OS !== 'android' ||
    !LegacyFileSystem.StorageAccessFramework
  ) {
    return { savedToDevice: false, reason: 'unsupported_platform' };
  }

  try {
    const downloadsRootUri =
      LegacyFileSystem.StorageAccessFramework.getUriForDirectoryInRoot('Download');
    const permission =
      await LegacyFileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(
        downloadsRootUri
      );

    if (!permission.granted) {
      return { savedToDevice: false, reason: 'permission_denied' };
    }

    const targetUri = await LegacyFileSystem.StorageAccessFramework.createFileAsync(
      permission.directoryUri,
      fileName,
      'application/pdf'
    );

    await LegacyFileSystem.StorageAccessFramework.writeAsStringAsync(
      targetUri,
      base64Contents,
      {
        encoding: LegacyFileSystem.EncodingType.Base64,
      }
    );

    return {
      savedToDevice: true,
      directoryUri: permission.directoryUri,
      targetUri,
    };
  } catch (error) {
    return {
      savedToDevice: false,
      reason: 'write_failed',
      error,
    };
  }
}

export default function App() {
  const [documentUri, setDocumentUri] = useState(null);
  const [documentName, setDocumentName] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [documentKey, setDocumentKey] = useState(null);
  const [base64Data, setBase64Data] = useState(null);
  const [viewerHtml, setViewerHtml] = useState(null);
  const [annotationState, setAnnotationState] = useState({});
  const [selectedAnnotation, setSelectedAnnotation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savingAnnotatedPdf, setSavingAnnotatedPdf] = useState(false);
  const [activeTool, setActiveTool] = useState('view');
  const [activeColor, setActiveColor] = useState(DEFAULT_COLOR);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showToolbar, setShowToolbar] = useState(true);
  const [totalPages, setTotalPages] = useState(0);
  const [textNoteModal, setTextNoteModal] = useState(null);
  const [noteText, setNoteText] = useState('');

  const webViewRef = useRef(null);
  const annotationWriteQueueRef = useRef(Promise.resolve());
  const annotationDirectoryReadyRef = useRef(false);

  const ensureAnnotationStorageDirectory = useCallback(async () => {
    if (annotationDirectoryReadyRef.current) {
      return;
    }

    try {
      await LegacyFileSystem.makeDirectoryAsync(ANNOTATION_STORAGE_DIR, {
        intermediates: true,
      });
    } catch (error) {
      if (!String(error?.message || '').toLowerCase().includes('exists')) {
        throw error;
      }
    }

    annotationDirectoryReadyRef.current = true;
  }, []);

  const persistAnnotationState = useCallback(
    (nextDocumentKey, nextAnnotations) => {
      if (!nextDocumentKey) {
        return;
      }

      const normalizedAnnotations = normalizeAnnotationState(nextAnnotations);

      annotationWriteQueueRef.current = annotationWriteQueueRef.current
        .then(async () => {
          await ensureAnnotationStorageDirectory();
          const annotationUri = getAnnotationStorageUri(nextDocumentKey);

          if (!hasAnnotations(normalizedAnnotations)) {
            const info = await LegacyFileSystem.getInfoAsync(annotationUri);
            if (info.exists) {
              await LegacyFileSystem.deleteAsync(annotationUri);
            }
            return;
          }

          await LegacyFileSystem.writeAsStringAsync(
            annotationUri,
            JSON.stringify({
              version: 1,
              annotations: normalizedAnnotations,
            })
          );
        })
        .catch((error) => {
          Alert.alert(
            'Annotation Save Error',
            'Failed to save annotations: ' + error.message
          );
        });
    },
    [ensureAnnotationStorageDirectory]
  );

  const loadPersistedAnnotations = useCallback(
    async (nextDocumentKey) => {
      if (!nextDocumentKey) {
        return {};
      }

      await ensureAnnotationStorageDirectory();
      const annotationUri = getAnnotationStorageUri(nextDocumentKey);
      const info = await LegacyFileSystem.getInfoAsync(annotationUri);

      if (!info.exists) {
        return {};
      }

      const rawContents = await LegacyFileSystem.readAsStringAsync(annotationUri);
      const parsed = JSON.parse(rawContents);
      return normalizeAnnotationState(parsed.annotations || parsed);
    },
    [ensureAnnotationStorageDirectory]
  );

  const sendCommand = useCallback((command) => {
    if (!webViewRef.current) {
      return;
    }

    const js = `
      (function() {
        try {
          var message = ${JSON.stringify(JSON.stringify(command))};
          var parsed = JSON.parse(message);
          switch (parsed.command) {
            case 'setMode':
              typeof setMode === 'function' && setMode(parsed.mode);
              break;
            case 'setDrawColor':
              typeof setDrawColor === 'function' && setDrawColor(parsed.color);
              break;
            case 'setHighlightColor':
              typeof setHighlightColor === 'function' && setHighlightColor(parsed.color);
              break;
            case 'addTextNote':
              typeof addTextNote === 'function' &&
                addTextNote(parsed.page, parsed.x, parsed.y, parsed.text);
              break;
            case 'clearPage':
              typeof clearAnnotations === 'function' && clearAnnotations(parsed.page);
              break;
            case 'clearAll':
              typeof clearAllAnnotations === 'function' && clearAllAnnotations();
              break;
            case 'deleteSelected':
              typeof deleteSelectedAnnotation === 'function' && deleteSelectedAnnotation();
              break;
          }
        } catch (error) {
          console.error('Command error:', error);
        }
      })();
      true;
    `;

    webViewRef.current.injectJavaScript(js);
  }, []);

  const pickDocument = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-powerpoint',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/plain',
          'image/*',
        ],
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        return;
      }

      const file = result.assets[0];
      const extension = file.name.split('.').pop().toLowerCase();

      setLoading(true);
      setDocumentUri(file.uri);
      setDocumentName(file.name);
      setDocumentType(extension);
      setTotalPages(0);
      setTextNoteModal(null);
      setNoteText('');
      setActiveTool('view');
      setActiveColor(DEFAULT_COLOR);
      setShowColorPicker(false);
      setShowToolbar(true);
      setSelectedAnnotation(null);
      setAnnotationState({});
      setBase64Data(null);
      setViewerHtml(null);

      if (extension === 'pdf') {
        const fileInfo = await LegacyFileSystem.getInfoAsync(file.uri, { md5: true });
        const nextDocumentKey =
          fileInfo.md5 || `${file.name}-${fileInfo.size || Date.now()}`;
        const [base64, persistedAnnotations] = await Promise.all([
          LegacyFileSystem.readAsStringAsync(file.uri, {
            encoding: LegacyFileSystem.EncodingType.Base64,
          }),
          loadPersistedAnnotations(nextDocumentKey),
        ]);

        setDocumentKey(nextDocumentKey);
        setBase64Data(base64);
        setAnnotationState(persistedAnnotations);
        setViewerHtml(
          getPdfViewerHtml(base64, {
            initialAnnotations: persistedAnnotations,
            initialMode: 'view',
            initialDrawColor: DEFAULT_COLOR,
            initialHighlightColor: DEFAULT_COLOR + HIGHLIGHT_ALPHA_HEX,
          })
        );
      } else {
        setDocumentKey(null);
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick document: ' + error.message);
    } finally {
      setLoading(false);
    }
  }, [loadPersistedAnnotations]);

  const copyDocument = useCallback(async () => {
    if (!documentUri) {
      return;
    }

    try {
      const extension = documentName.split('.').pop();
      const baseName = documentName.replace('.' + extension, '');
      const newName = `${baseName}_copy.${extension}`;
      const nextUri = Paths.document.uri + newName;

      await LegacyFileSystem.copyAsync({
        from: documentUri,
        to: nextUri,
      });

      Alert.alert('Success', 'Document copied as: ' + newName);
    } catch (error) {
      Alert.alert('Error', 'Failed to copy: ' + error.message);
    }
  }, [documentName, documentUri]);

  const shareDocument = useCallback(async () => {
    if (!documentUri) {
      return;
    }

    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('Error', 'Sharing is not available on this device');
        return;
      }

      await Sharing.shareAsync(documentUri);
    } catch (error) {
      Alert.alert('Error', 'Failed to share: ' + error.message);
    }
  }, [documentUri]);

  const selectTool = useCallback(
    (toolId) => {
      setActiveTool(toolId);
      setSelectedAnnotation(null);
      setShowColorPicker(toolId === 'draw' || toolId === 'highlight');
      sendCommand({ command: 'setMode', mode: toolId });
    },
    [sendCommand]
  );

  const selectColor = useCallback(
    (color) => {
      setActiveColor(color);
      if (activeTool === 'draw') {
        sendCommand({ command: 'setDrawColor', color });
      } else if (activeTool === 'highlight') {
        sendCommand({
          command: 'setHighlightColor',
          color: color + HIGHLIGHT_ALPHA_HEX,
        });
      }
    },
    [activeTool, sendCommand]
  );

  const deleteSelectedAnnotation = useCallback(() => {
    if (!selectedAnnotation) {
      return;
    }

    sendCommand({ command: 'deleteSelected' });
  }, [selectedAnnotation, sendCommand]);

  const clearAll = useCallback(() => {
    Alert.alert('Clear Annotations', 'Remove all highlights, drawings, and notes?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear All',
        style: 'destructive',
        onPress: () => sendCommand({ command: 'clearAll' }),
      },
    ]);
  }, [sendCommand]);

  const saveAnnotatedPdf = useCallback(async () => {
    if (!base64Data || documentType !== 'pdf') {
      return;
    }

    try {
      setSavingAnnotatedPdf(true);

      const pdfDocument = await PDFDocument.load(base64Data);
      const noteFont = await pdfDocument.embedFont(StandardFonts.Helvetica);
      const pages = pdfDocument.getPages();

      Object.entries(annotationState).forEach(([pageKey, pageAnnotations]) => {
        const page = pages[Number(pageKey) - 1];
        if (!page) {
          return;
        }

        const { width, height } = page.getSize();

        (pageAnnotations.highlights || []).forEach((highlight) => {
          const highlightWidth = clamp(Number(highlight.width) || 0, 0, 1) * width;
          const highlightHeight = clamp(Number(highlight.height) || 0, 0, 1) * height;

          if (highlightWidth < 1 || highlightHeight < 1) {
            return;
          }

          const { color, opacity } = parseHexColor(highlight.color, 0.4);
          const x = clamp(Number(highlight.x) || 0, 0, 1) * width;
          const y =
            height -
            (clamp(Number(highlight.y) || 0, 0, 1) + clamp(Number(highlight.height) || 0, 0, 1)) *
              height;

          page.drawRectangle({
            x,
            y,
            width: highlightWidth,
            height: highlightHeight,
            color,
            opacity,
            blendMode: BlendMode.Multiply,
          });
        });

        (pageAnnotations.drawings || []).forEach((drawing) => {
          const pdfPoints = (drawing.points || []).map((point) =>
            normalizePdfPoint(point, width, height)
          );

          if (!pdfPoints.length) {
            return;
          }

          const { color, opacity } = parseHexColor(drawing.color, 1);
          const thickness = Math.max(
            clamp(Number(drawing.width) || 0.006, 0.001, 0.05) * width,
            1.2
          );

          if (pdfPoints.length === 1) {
            page.drawCircle({
              x: pdfPoints[0].x,
              y: pdfPoints[0].y,
              size: Math.max(thickness / 2, 0.8),
              color,
              opacity,
            });
            return;
          }

          for (let index = 0; index < pdfPoints.length - 1; index += 1) {
            page.drawLine({
              start: pdfPoints[index],
              end: pdfPoints[index + 1],
              thickness,
              color,
              opacity,
              lineCap: LineCapStyle.Round,
            });
          }
        });

        (pageAnnotations.notes || []).forEach((note) => {
          const fontSize = 12;
          const lineHeight = fontSize * 1.25;
          const maxTextWidth = Math.min(width * 0.35, 180);
          const lines = wrapNoteText(note.text, noteFont, fontSize, maxTextWidth);
          const textWidth = lines.reduce((currentWidth, line) => {
            const measuredWidth = noteFont.widthOfTextAtSize(line || ' ', fontSize);
            return Math.max(currentWidth, measuredWidth);
          }, 40);

          const noteWidth = Math.min(textWidth + 14, width * 0.42);
          const noteHeight = Math.max(lines.length * lineHeight + 14, 28);
          const x = clamp(
            (Number(note.x) || 0) * width,
            8,
            Math.max(width - noteWidth - 8, 8)
          );
          const y = clamp(
            height - (clamp(Number(note.y) || 0, 0, 1) * height) - noteHeight,
            8,
            Math.max(height - noteHeight - 8, 8)
          );

          page.drawRectangle({
            x,
            y,
            width: noteWidth,
            height: noteHeight,
            color: rgb(1, 0.976, 0.769),
            borderWidth: 1,
            borderColor: rgb(0.976, 0.659, 0.145),
            opacity: 0.98,
          });

          lines.forEach((line, index) => {
            page.drawText(line, {
              x: x + 7,
              y: y + noteHeight - 9 - fontSize - index * lineHeight,
              size: fontSize,
              font: noteFont,
              color: rgb(0.2, 0.2, 0.2),
            });
          });
        });
      });

      const bakedPdfBase64 = await pdfDocument.saveAsBase64();
      const fileName = buildAnnotatedFileName(documentName);
      const outputUri = `${Paths.document.uri}${fileName}`;

      await LegacyFileSystem.writeAsStringAsync(outputUri, bakedPdfBase64, {
        encoding: LegacyFileSystem.EncodingType.Base64,
      });

      const deviceSaveResult =
        Platform.OS === 'android'
          ? await savePdfToAndroidDeviceFolder(bakedPdfBase64, fileName)
          : { savedToDevice: false, reason: 'unsupported_platform' };

      const canShare = await Sharing.isAvailableAsync();
      const saveSummary = [`Saved in app storage as ${fileName}.`];

      if (deviceSaveResult.savedToDevice) {
        saveSummary.push(
          'A second copy was also saved to the folder you picked on your phone.'
        );
      } else if (Platform.OS === 'android') {
        saveSummary.push(
          'The visible device copy was not created. Next time, allow the folder picker to save directly into phone storage.'
        );
      }

      Alert.alert('Annotated PDF Saved', saveSummary.join(' '), [
        ...(canShare
          ? [
              {
                text: 'Share',
                onPress: () => Sharing.shareAsync(outputUri),
              },
            ]
          : []),
        { text: 'OK' },
      ]);
    } catch (error) {
      Alert.alert(
        'Save Failed',
        'Could not save the annotated PDF: ' + error.message
      );
    } finally {
      setSavingAnnotatedPdf(false);
    }
  }, [annotationState, base64Data, documentName, documentType]);

  const handleWebViewMessage = useCallback(
    (event) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);

        switch (data.type) {
          case 'pdfLoaded':
            setTotalPages(data.totalPages);
            sendCommand({ command: 'setMode', mode: activeTool });
            sendCommand({ command: 'setDrawColor', color: activeColor });
            sendCommand({
              command: 'setHighlightColor',
              color: activeColor + HIGHLIGHT_ALPHA_HEX,
            });
            break;
          case 'requestTextInput':
            setTextNoteModal({ page: data.page, x: data.x, y: data.y });
            setNoteText('');
            break;
          case 'annotationSelected':
            setSelectedAnnotation(data.annotation || null);
            break;
          case 'annotationsChanged': {
            const nextAnnotations = normalizeAnnotationState(data.annotations);
            setAnnotationState(nextAnnotations);
            persistAnnotationState(documentKey, nextAnnotations);
            setSelectedAnnotation((currentSelection) => {
              if (!currentSelection) {
                return currentSelection;
              }

              const pageAnnotations = nextAnnotations[currentSelection.page];
              if (!pageAnnotations) {
                return null;
              }

              const bucket =
                currentSelection.type === 'highlight'
                  ? pageAnnotations.highlights
                  : currentSelection.type === 'drawing'
                    ? pageAnnotations.drawings
                    : pageAnnotations.notes;

              return bucket.some(
                (annotation) => annotation.id === currentSelection.id
              )
                ? currentSelection
                : null;
            });
            break;
          }
          case 'modeChanged':
            if (data.mode !== 'view') {
              setSelectedAnnotation(null);
            }
            break;
          case 'error':
            Alert.alert('PDF Error', data.message);
            break;
        }
      } catch (_) {}
    },
    [activeColor, activeTool, documentKey, persistAnnotationState, sendCommand]
  );

  const submitTextNote = useCallback(() => {
    if (textNoteModal && noteText.trim()) {
      sendCommand({
        command: 'addTextNote',
        page: textNoteModal.page,
        x: textNoteModal.x,
        y: textNoteModal.y,
        text: noteText.trim(),
      });
    }

    setTextNoteModal(null);
    setNoteText('');
  }, [noteText, sendCommand, textNoteModal]);

  const renderNonPdfViewer = () => {
    const extension = documentType;

    if (['txt'].includes(extension)) {
      return (
        <View style={styles.nonPdfContainer}>
          <TextFileViewer uri={documentUri} />
        </View>
      );
    }

    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(extension)) {
      return (
        <View style={styles.nonPdfContainer}>
          <WebView
            source={{ uri: documentUri }}
            style={styles.webView}
            scalesPageToFit={true}
          />
        </View>
      );
    }

    if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(extension)) {
      return (
        <View style={styles.nonPdfContainer}>
          <OfficeDocViewer uri={documentUri} name={documentName} />
        </View>
      );
    }

    return (
      <View style={styles.unsupported}>
        <Text style={styles.unsupportedText}>
          Preview not available for .{extension} files.
        </Text>
        <Text style={styles.unsupportedHint}>
          You can still copy or share this document using the buttons above.
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {documentName || 'Document Viewer'}
        </Text>
        {totalPages > 0 && <Text style={styles.pageCount}>{totalPages} pages</Text>}
      </View>

      {!documentUri && !loading && (
        <View style={styles.landing}>
          <Text style={styles.landingIcon}>📄</Text>
          <Text style={styles.landingTitle}>Document Viewer & Editor</Text>
          <Text style={styles.landingSubtitle}>
            Import PDFs, Word docs, PowerPoint, Excel, images, and text files
            from your device. View, annotate, and edit with built-in tools.
          </Text>
          <TouchableOpacity style={styles.importButton} onPress={pickDocument}>
            <Text style={styles.importButtonText}>📂  Import Document</Text>
          </TouchableOpacity>
          <Text style={styles.supportedFormats}>
            Supported: PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, TXT, Images
          </Text>
        </View>
      )}

      {loading && (
        <View style={styles.landing}>
          <ActivityIndicator size="large" color="#6200ee" />
          <Text style={styles.loadingText}>Loading document...</Text>
        </View>
      )}

      {documentUri && !loading && (
        <View style={styles.documentArea}>
          <View style={styles.actionBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <TouchableOpacity style={styles.actionBtn} onPress={pickDocument}>
                <Text style={styles.actionBtnText}>📂 Open</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionBtn} onPress={copyDocument}>
                <Text style={styles.actionBtnText}>📋 Copy</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionBtn} onPress={shareDocument}>
                <Text style={styles.actionBtnText}>📤 Share</Text>
              </TouchableOpacity>
              {documentType === 'pdf' && (
                <>
                  <TouchableOpacity
                    style={[
                      styles.actionBtnPrimary,
                      savingAnnotatedPdf && styles.actionBtnDisabled,
                    ]}
                    disabled={savingAnnotatedPdf}
                    onPress={saveAnnotatedPdf}
                  >
                    <Text style={styles.actionBtnPrimaryText}>
                      {savingAnnotatedPdf ? '⏳ Saving PDF...' : '💾 Save Annotated PDF'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.actionBtnDanger,
                      !selectedAnnotation && styles.actionBtnDisabled,
                    ]}
                    disabled={!selectedAnnotation}
                    onPress={deleteSelectedAnnotation}
                  >
                    <Text style={styles.actionBtnDangerText}>🗑 Delete Selected</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.actionBtn}
                    onPress={() => setShowToolbar((currentValue) => !currentValue)}
                  >
                    <Text style={styles.actionBtnText}>
                      {showToolbar ? '🔧 Hide Tools' : '🔧 Show Tools'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.actionBtnDanger} onPress={clearAll}>
                    <Text style={styles.actionBtnDangerText}>🧹 Clear All</Text>
                  </TouchableOpacity>
                </>
              )}
            </ScrollView>
          </View>

          {documentType === 'pdf' && (
            <View style={styles.selectionBar}>
              <Text style={styles.selectionText}>
                {activeTool === 'view'
                  ? getSelectedAnnotationDescription(selectedAnnotation)
                  : 'Switch to Select mode to tap an annotation before deleting it.'}
              </Text>
            </View>
          )}

          {documentType === 'pdf' && showToolbar && (
            <View style={styles.toolbar}>
              <View style={styles.toolRow}>
                {TOOLS.map((tool) => (
                  <TouchableOpacity
                    key={tool.id}
                    style={[
                      styles.toolBtn,
                      activeTool === tool.id && styles.toolBtnActive,
                    ]}
                    onPress={() => selectTool(tool.id)}
                  >
                    <Text
                      style={[
                        styles.toolBtnText,
                        activeTool === tool.id && styles.toolBtnTextActive,
                      ]}
                    >
                      {tool.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {showColorPicker && (
                <View style={styles.colorRow}>
                  {COLORS.map((color) => (
                    <TouchableOpacity
                      key={color.value}
                      style={[
                        styles.colorBtn,
                        { backgroundColor: color.value },
                        activeColor === color.value && styles.colorBtnActive,
                      ]}
                      onPress={() => selectColor(color.value)}
                    />
                  ))}
                </View>
              )}
            </View>
          )}

          {documentType === 'pdf' && viewerHtml ? (
            <WebView
              key={documentKey || documentUri}
              ref={webViewRef}
              source={{ html: viewerHtml }}
              style={styles.webView}
              originWhitelist={['*']}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              onMessage={handleWebViewMessage}
              startInLoadingState={true}
              renderLoading={() => (
                <ActivityIndicator
                  style={styles.loadingCenter}
                  size="large"
                  color="#6200ee"
                />
              )}
              scrollEnabled={true}
              scalesPageToFit={false}
              allowFileAccess={true}
              mixedContentMode="always"
            />
          ) : (
            renderNonPdfViewer()
          )}
        </View>
      )}

      <Modal
        visible={textNoteModal !== null}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setTextNoteModal(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Add Note</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Type your note here..."
              placeholderTextColor="#999"
              value={noteText}
              onChangeText={setNoteText}
              multiline
              autoFocus
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalBtnCancel}
                onPress={() => setTextNoteModal(null)}
              >
                <Text style={styles.modalBtnCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnSubmit} onPress={submitTextNote}>
                <Text style={styles.modalBtnSubmitText}>Add Note</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function TextFileViewer({ uri }) {
  const [content, setContent] = useState('');
  const [loadingText, setLoadingText] = useState(true);

  React.useEffect(() => {
    (async () => {
      try {
        const file = new File(uri);
        const text = await file.text();
        setContent(text);
      } catch (error) {
        setContent('Error reading file: ' + error.message);
      }
      setLoadingText(false);
    })();
  }, [uri]);

  if (loadingText) {
    return <ActivityIndicator size="large" color="#6200ee" />;
  }

  return (
    <ScrollView style={styles.textViewerScroll}>
      <Text style={styles.textViewerContent} selectable>
        {content}
      </Text>
    </ScrollView>
  );
}

function OfficeDocViewer({ uri, name }) {
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  React.useEffect(() => {
    (async () => {
      try {
        const extension = name.split('.').pop().toLowerCase();
        const tempName = 'office_preview_' + Date.now() + '.' + extension;
        const tempUri = Paths.cache.uri + tempName;

        await LegacyFileSystem.copyAsync({
          from: uri,
          to: tempUri,
        });

        setIsLoading(false);
      } catch (loadError) {
        setError('Could not load document: ' + loadError.message);
        setIsLoading(false);
      }
    })();
  }, [name, uri]);

  if (isLoading) {
    return (
      <View style={styles.landing}>
        <ActivityIndicator size="large" color="#6200ee" />
        <Text style={styles.loadingText}>Loading document...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.unsupported}>
        <Text style={styles.unsupportedText}>{error}</Text>
      </View>
    );
  }

  const officeHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          background: #f5f5f5;
          padding: 20px;
          text-align: center;
        }
        .icon { font-size: 64px; margin-bottom: 16px; }
        h2 { color: #333; margin-bottom: 8px; font-size: 18px; }
        p { color: #666; font-size: 14px; line-height: 1.5; max-width: 300px; }
        .filename {
          color: #6200ee;
          font-weight: 600;
          word-break: break-all;
          margin: 12px 0;
          background: #ede7f6;
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 13px;
        }
        .tip {
          margin-top: 20px;
          padding: 12px 16px;
          background: #e3f2fd;
          border-radius: 8px;
          color: #1565c0;
          font-size: 12px;
        }
      </style>
    </head>
    <body>
      <div class="icon">📄</div>
      <h2>${name}</h2>
      <p class="filename">${name}</p>
      <p>This Office document has been imported successfully.</p>
      <p>Use the <strong>Share</strong> button above to open it in Microsoft Office, Google Docs, or another editor on your device.</p>
      <div class="tip">
        Tip: Tap "Share" to open in your preferred Office app for full editing capabilities.
      </div>
    </body>
    </html>
  `;

  return (
    <WebView
      source={{ html: officeHtml }}
      style={styles.webView}
      scrollEnabled={true}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  header: {
    paddingTop: Platform.OS === 'android' ? 40 : 50,
    paddingBottom: 12,
    paddingHorizontal: 16,
    backgroundColor: '#16213e',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#0f3460',
  },
  headerTitle: {
    color: '#e0e0e0',
    fontSize: 18,
    fontWeight: '700',
    flex: 1,
  },
  pageCount: {
    color: '#888',
    fontSize: 13,
    marginLeft: 8,
  },
  landing: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  landingIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  landingTitle: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  landingSubtitle: {
    color: '#aaa',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
    paddingHorizontal: 16,
  },
  importButton: {
    backgroundColor: '#6200ee',
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 12,
    elevation: 4,
    shadowColor: '#6200ee',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  importButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  supportedFormats: {
    color: '#666',
    fontSize: 11,
    marginTop: 20,
    textAlign: 'center',
  },
  loadingText: {
    color: '#aaa',
    marginTop: 16,
    fontSize: 14,
  },
  documentArea: {
    flex: 1,
  },
  actionBar: {
    backgroundColor: '#16213e',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#0f3460',
  },
  actionBtn: {
    backgroundColor: '#0f3460',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginHorizontal: 4,
  },
  actionBtnPrimary: {
    backgroundColor: '#0d6e6e',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginHorizontal: 4,
  },
  actionBtnText: {
    color: '#e0e0e0',
    fontSize: 13,
    fontWeight: '500',
  },
  actionBtnPrimaryText: {
    color: '#eaffff',
    fontSize: 13,
    fontWeight: '600',
  },
  actionBtnDanger: {
    backgroundColor: '#b71c1c',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginHorizontal: 4,
  },
  actionBtnDangerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
  actionBtnDisabled: {
    opacity: 0.5,
  },
  selectionBar: {
    backgroundColor: '#10192f',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#0f3460',
  },
  selectionText: {
    color: '#b8c6ea',
    fontSize: 12,
    lineHeight: 18,
  },
  toolbar: {
    backgroundColor: '#1a1a2e',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#0f3460',
  },
  toolRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  toolBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#16213e',
  },
  toolBtnActive: {
    backgroundColor: '#6200ee',
  },
  toolBtnText: {
    color: '#aaa',
    fontSize: 13,
    fontWeight: '500',
  },
  toolBtnTextActive: {
    color: '#fff',
  },
  colorRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 8,
    gap: 8,
  },
  colorBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorBtnActive: {
    borderColor: '#fff',
    borderWidth: 3,
  },
  webView: {
    flex: 1,
    backgroundColor: '#525659',
  },
  loadingCenter: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginLeft: -20,
    marginTop: -20,
  },
  nonPdfContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  unsupported: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  unsupportedText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  unsupportedHint: {
    color: '#888',
    fontSize: 13,
    textAlign: 'center',
  },
  textViewerScroll: {
    flex: 1,
    padding: 16,
  },
  textViewerContent: {
    fontSize: 14,
    lineHeight: 22,
    color: '#333',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '85%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
    marginBottom: 16,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
    color: '#333',
    marginBottom: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  modalBtnCancel: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  modalBtnCancelText: {
    color: '#888',
    fontSize: 14,
    fontWeight: '500',
  },
  modalBtnSubmit: {
    backgroundColor: '#6200ee',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  modalBtnSubmitText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
