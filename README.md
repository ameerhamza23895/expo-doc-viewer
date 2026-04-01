# Expo Document Viewer & Editor

A React Native Expo Go project for importing, viewing, and annotating PDF documents (and other file formats) on Android.

## Features

- **Document Import**: Pick PDF, Word (DOC/DOCX), PowerPoint (PPT/PPTX), Excel (XLS/XLSX), text, and image files from your device
- **PDF Viewer**: Full PDF rendering using PDF.js inside a WebView — works in Expo Go without ejecting
- **Highlight Tool**: Draw highlight rectangles over PDF content with customizable colors
- **Freehand Drawing**: Draw freehand annotations on any page
- **Text Notes**: Add sticky-note-style text annotations anywhere on the PDF
- **Copy Document**: Create a local copy of the imported document
- **Share/Export**: Share the document via the system share sheet
- **Multi-format Support**: View Office documents via Google Docs Viewer, plain text files, and images

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Expo CLI](https://docs.expo.dev/get-started/installation/)
- [Expo Go](https://expo.dev/client) app on your Android device

### Installation

```bash
# Clone the repo
git clone https://github.com/ameerhamza23895/expo-doc-viewer.git
cd expo-doc-viewer

# Install dependencies
npm install

# Start the development server
npx expo start
```

### Running on Android

1. Install the **Expo Go** app from the Google Play Store
2. Run `npx expo start` in the project directory
3. Scan the QR code with Expo Go

## Project Structure

```
expo-doc-viewer/
├── App.js                      # Main app component (single page)
├── src/
│   └── utils/
│       └── pdfViewerHtml.js    # PDF.js WebView HTML template with annotation support
├── app.json                    # Expo configuration
├── package.json                # Dependencies
└── assets/                     # App icons and splash screen
```

## How It Works

1. **Import**: Tap "Import Document" to pick a file from your device
2. **View**: PDFs are rendered using Mozilla's PDF.js inside a WebView for full compatibility with Expo Go
3. **Annotate**: Use the toolbar to switch between View, Highlight, Draw, and Note modes
4. **Colors**: Pick from 5 annotation colors (Red, Blue, Green, Orange, Purple)
5. **Copy**: Create a duplicate of the document in app storage
6. **Share**: Export the document via the Android share sheet
7. **Clear**: Remove all annotations with the Clear All button (double-tap individual annotations to delete them)

## Tech Stack

- **React Native** with **Expo SDK 54**
- **expo-document-picker** — file selection
- **expo-file-system** — file operations (read, copy)
- **expo-sharing** — share sheet integration
- **react-native-webview** — PDF rendering via PDF.js
- **PDF.js 3.11** (CDN) — PDF parsing and rendering

## License

MIT
