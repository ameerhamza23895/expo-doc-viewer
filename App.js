import React, { useState, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Alert,
  Modal,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { WebView } from 'react-native-webview';
import { getPdfViewerHtml } from './src/utils/pdfViewerHtml';

const TOOLS = [
  { id: 'view', label: '👁 View', icon: '👁' },
  { id: 'highlight', label: '🖍 Highlight', icon: '🖍' },
  { id: 'draw', label: '✏️ Draw', icon: '✏️' },
  { id: 'text', label: '📝 Note', icon: '📝' },
];

const COLORS = [
  { name: 'Red', value: '#FF0000' },
  { name: 'Blue', value: '#2196F3' },
  { name: 'Green', value: '#4CAF50' },
  { name: 'Orange', value: '#FF9800' },
  { name: 'Purple', value: '#9C27B0' },
];

export default function App() {
  const [documentUri, setDocumentUri] = useState(null);
  const [documentName, setDocumentName] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [base64Data, setBase64Data] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTool, setActiveTool] = useState('view');
  const [activeColor, setActiveColor] = useState('#FF0000');
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [totalPages, setTotalPages] = useState(0);
  const [textNoteModal, setTextNoteModal] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [showToolbar, setShowToolbar] = useState(true);

  const webViewRef = useRef(null);

  // Pick a document from the device
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

      if (result.canceled) return;

      const file = result.assets[0];
      setLoading(true);
      setDocumentName(file.name);
      setDocumentUri(file.uri);

      // Determine document type
      const ext = file.name.split('.').pop().toLowerCase();
      setDocumentType(ext);

      if (ext === 'pdf') {
        // Read the PDF as base64 for WebView rendering
        const base64 = await LegacyFileSystem.readAsStringAsync(file.uri, {
          encoding: LegacyFileSystem.EncodingType.Base64,
        });
        setBase64Data(base64);
      } else {
        // For non-PDF files, we'll still load them
        setBase64Data(null);
      }

      setLoading(false);
    } catch (err) {
      setLoading(false);
      Alert.alert('Error', 'Failed to pick document: ' + err.message);
    }
  }, []);

  // Make a copy of the document
  const copyDocument = useCallback(async () => {
    if (!documentUri) return;

    try {
      const ext = documentName.split('.').pop();
      const baseName = documentName.replace('.' + ext, '');
      const newName = baseName + '_copy.' + ext;
      const newUri = Paths.document.uri + newName;

      await LegacyFileSystem.copyAsync({
        from: documentUri,
        to: newUri,
      });

      Alert.alert('Success', 'Document copied as: ' + newName);
    } catch (err) {
      Alert.alert('Error', 'Failed to copy: ' + err.message);
    }
  }, [documentUri, documentName]);

  // Share / export the document
  const shareDocument = useCallback(async () => {
    if (!documentUri) return;

    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('Error', 'Sharing is not available on this device');
        return;
      }
      await Sharing.shareAsync(documentUri);
    } catch (err) {
      Alert.alert('Error', 'Failed to share: ' + err.message);
    }
  }, [documentUri]);

  // Send a command to the WebView
  const sendCommand = useCallback((command) => {
    if (webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify(command));
    }
  }, []);

  // Handle tool selection
  const selectTool = useCallback((toolId) => {
    setActiveTool(toolId);
    sendCommand({ command: 'setMode', mode: toolId });
    if (toolId === 'draw' || toolId === 'highlight') {
      setShowColorPicker(true);
    } else {
      setShowColorPicker(false);
    }
  }, [sendCommand]);

  // Handle color selection
  const selectColor = useCallback((color) => {
    setActiveColor(color);
    if (activeTool === 'draw') {
      sendCommand({ command: 'setDrawColor', color });
    } else if (activeTool === 'highlight') {
      const alpha = '66'; // ~40% opacity
      sendCommand({ command: 'setHighlightColor', color: color + alpha });
    }
  }, [activeTool, sendCommand]);

  // Clear all annotations
  const clearAll = useCallback(() => {
    Alert.alert(
      'Clear Annotations',
      'Remove all highlights, drawings, and notes?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: () => sendCommand({ command: 'clearAll' }),
        },
      ]
    );
  }, [sendCommand]);

  // Handle messages from WebView
  const handleWebViewMessage = useCallback((event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      switch (data.type) {
        case 'pdfLoaded':
          setTotalPages(data.totalPages);
          break;
        case 'requestTextInput':
          setTextNoteModal({ page: data.page, x: data.x, y: data.y });
          setNoteText('');
          break;
        case 'error':
          Alert.alert('PDF Error', data.message);
          break;
      }
    } catch (_) {}
  }, []);

  // Submit text note
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
  }, [textNoteModal, noteText, sendCommand]);

  // Render the non-PDF document viewer (for txt, images, etc.)
  const renderNonPdfViewer = () => {
    const ext = documentType;
    if (['txt'].includes(ext)) {
      return (
        <View style={styles.nonPdfContainer}>
          <TextFileViewer uri={documentUri} />
        </View>
      );
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
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
    // For Office docs, use Google Docs Viewer
    if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) {
      return (
        <View style={styles.nonPdfContainer}>
          <Text style={styles.officeNote}>
            Office documents are displayed in read-only mode via Google Docs Viewer.
            For editing, use the PDF viewer with annotation tools.
          </Text>
          <WebView
            source={{
              uri: `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(documentUri)}`,
            }}
            style={styles.webView}
            startInLoadingState={true}
            renderLoading={() => (
              <ActivityIndicator style={styles.loadingCenter} size="large" color="#6200ee" />
            )}
          />
        </View>
      );
    }
    return (
      <View style={styles.unsupported}>
        <Text style={styles.unsupportedText}>
          Preview not available for .{ext} files.
        </Text>
        <Text style={styles.unsupportedHint}>
          You can still copy or share this document using the buttons above.
        </Text>
      </View>
    );
  };

  // ---- Main Render ----
  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {documentName || 'Document Viewer'}
        </Text>
        {totalPages > 0 && (
          <Text style={styles.pageCount}>{totalPages} pages</Text>
        )}
      </View>

      {/* No document loaded - landing screen */}
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

      {/* Loading */}
      {loading && (
        <View style={styles.landing}>
          <ActivityIndicator size="large" color="#6200ee" />
          <Text style={styles.loadingText}>Loading document...</Text>
        </View>
      )}

      {/* Document loaded */}
      {documentUri && !loading && (
        <View style={styles.documentArea}>
          {/* Action bar */}
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
                    style={styles.actionBtn}
                    onPress={() => setShowToolbar(!showToolbar)}
                  >
                    <Text style={styles.actionBtnText}>
                      {showToolbar ? '🔧 Hide Tools' : '🔧 Show Tools'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.actionBtnDanger} onPress={clearAll}>
                    <Text style={styles.actionBtnDangerText}>🗑 Clear All</Text>
                  </TouchableOpacity>
                </>
              )}
            </ScrollView>
          </View>

          {/* Annotation toolbar (PDF only) */}
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

          {/* PDF Viewer */}
          {documentType === 'pdf' && base64Data ? (
            <WebView
              ref={webViewRef}
              source={{ html: getPdfViewerHtml(base64Data) }}
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

      {/* Text note input modal */}
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
              <TouchableOpacity
                style={styles.modalBtnSubmit}
                onPress={submitTextNote}
              >
                <Text style={styles.modalBtnSubmitText}>Add Note</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Simple text file viewer component
function TextFileViewer({ uri }) {
  const [content, setContent] = useState('');
  const [loadingText, setLoadingText] = useState(true);

  React.useEffect(() => {
    (async () => {
      try {
        const file = new File(uri);
        const text = await file.text();
        setContent(text);
      } catch (err) {
        setContent('Error reading file: ' + err.message);
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
  // Landing
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
  // Document area
  documentArea: {
    flex: 1,
  },
  // Action bar
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
  actionBtnText: {
    color: '#e0e0e0',
    fontSize: 13,
    fontWeight: '500',
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
  // Toolbar
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
  // WebView
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
  // Non-PDF
  nonPdfContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  officeNote: {
    backgroundColor: '#fff3e0',
    padding: 12,
    fontSize: 12,
    color: '#e65100',
    textAlign: 'center',
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
  // Text viewer
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
  // Modal
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
