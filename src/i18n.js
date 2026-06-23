// Shared i18n dictionary for both the main process (require) and the renderer (window.i18n).
// Keep keys stable; English is the fallback when a key is missing in another language.
//
// Wrapped in an IIFE so NONE of its names land in global scope. As a classic <script> in the
// renderer, a top-level `const api` collided with the non-configurable `window.api` exposed by
// the preload (SyntaxError: "Identifier 'api' has already been declared"), which broke i18n and
// every t() call. The IIFE also avoids clashing with the renderer's own top-level `const t`.
(function () {
const translations = {
  en: {
    'menu.workspace': 'Workspace',
    'menu.newWindow': 'New Window',
    'menu.openWorkspace': 'Open Workspace...',
    'menu.openWorkspaceFile': 'Open Workspace File...',
    'menu.refresh': 'Refresh',
    'menu.saveWorkspace': 'Save Workspace...',
    'menu.exit': 'Exit',
    'menu.language': 'Language',
    'menu.english': 'English',
    'menu.japanese': '日本語',
    'dialog.openWorkspace': 'Open Workspace',
    'dialog.openWorkspaceFile': 'Open Workspace File',
    'dialog.saveWorkspace': 'Save Workspace',
    'dialog.openFileFailed': 'Open Workspace File failed',
    'filter.workspace': 'WSL Workbench Workspace',
    'filter.allFiles': 'All Files',
    'toolbar.startClaude': 'Start Claude',
    'toolbar.startClaudeTitle': 'Runs: claude --dangerously-skip-permissions (skips permission prompts)',
    'editor.title': 'Editor',
    'editor.placeholder': 'Select a text file from the left tree.',
    'editor.unsaved': '● unsaved',
    'landing.subtitle': 'Open a workspace to get started',
    'landing.openWorkspace': 'Open Workspace…',
    'landing.openWorkspaceFile': 'Open Workspace File…',
    'ctx.newFile': 'New File',
    'ctx.newFolder': 'New Folder',
    'ctx.rename': 'Rename',
    'ctx.delete': 'Delete',
    'ctx.reveal': 'Reveal in Explorer',
    'ctx.openNewWindow': 'Open in New Window',
    'prompt.ok': 'OK',
    'prompt.cancel': 'Cancel',
    'prompt.newFolderName': 'New folder name:',
    'prompt.newFileName': 'New file name:',
    'prompt.newName': 'New name:',
    'confirm.discardChanges': 'Unsaved changes will be discarded. Continue?',
    'confirm.deleteDir': 'Delete this directory and all contents?',
    'confirm.deleteFile': 'Delete this file?',
    'menu.edit': 'Edit',
    'menu.undo': 'Undo',
    'menu.redo': 'Redo',
    'menu.cut': 'Cut',
    'menu.copy': 'Copy',
    'menu.paste': 'Paste',
    'menu.selectAll': 'Select All',
    'menu.view': 'View',
    'menu.reload': 'Reload',
    'menu.forceReload': 'Force Reload',
    'menu.toggleDevTools': 'Toggle Developer Tools',
    'menu.resetZoom': 'Actual Size',
    'menu.zoomIn': 'Zoom In',
    'menu.zoomOut': 'Zoom Out',
    'menu.toggleFullscreen': 'Toggle Full Screen',
    'ui.dragToResize': 'Drag to resize',
    'menu.restartTerminal': 'Restart Terminal',
    'menu.help': 'Help',
    'menu.about': 'About WSL Workbench',
    'about.currentVersion': 'Current version',
    'about.latestVersion': 'Latest version',
    'about.upToDate': 'You are using the latest version.',
    'about.updateAvailable': 'A newer version is available.',
    'about.openReleasePage': 'Open release page',
    'about.checkFailed': 'Could not check for the latest version.',
    'about.close': 'Close',
    'terminal.exited': '[terminal exited]',
    'terminal.restartHint': '[Press Enter to restart the terminal]',
    'claude.notFound': 'Error: claude not found in WSL PATH (only a Windows claude under /mnt, if any). Install it inside WSL: npm i -g @anthropic-ai/claude-code'
  },
  ja: {
    'menu.workspace': 'ワークスペース',
    'menu.newWindow': '新しいウィンドウ',
    'menu.openWorkspace': 'ワークスペースを開く...',
    'menu.openWorkspaceFile': 'ワークスペースファイルを開く...',
    'menu.refresh': '更新',
    'menu.saveWorkspace': 'ワークスペースを保存...',
    'menu.exit': '閉じる',
    'menu.language': '言語',
    'menu.english': 'English',
    'menu.japanese': '日本語',
    'dialog.openWorkspace': 'ワークスペースを開く',
    'dialog.openWorkspaceFile': 'ワークスペースファイルを開く',
    'dialog.saveWorkspace': 'ワークスペースを保存',
    'dialog.openFileFailed': 'ワークスペースファイルを開けませんでした',
    'filter.workspace': 'WSL Workbench ワークスペース',
    'filter.allFiles': 'すべてのファイル',
    'toolbar.startClaude': 'Claude を起動',
    'toolbar.startClaudeTitle': '実行: claude --dangerously-skip-permissions（権限確認をスキップ）',
    'editor.title': 'エディタ',
    'editor.placeholder': '左のツリーからテキストファイルを選択してください。',
    'editor.unsaved': '● 未保存',
    'landing.subtitle': 'ワークスペースを開いて開始します',
    'landing.openWorkspace': 'ワークスペースを開く…',
    'landing.openWorkspaceFile': 'ワークスペースファイルを開く…',
    'ctx.newFile': '新規ファイル',
    'ctx.newFolder': '新規フォルダ',
    'ctx.rename': '名前を変更',
    'ctx.delete': '削除',
    'ctx.reveal': 'エクスプローラーで表示',
    'ctx.openNewWindow': '新しいウィンドウで開く',
    'prompt.ok': 'OK',
    'prompt.cancel': 'キャンセル',
    'prompt.newFolderName': '新しいフォルダ名:',
    'prompt.newFileName': '新しいファイル名:',
    'prompt.newName': '新しい名前:',
    'confirm.discardChanges': '未保存の変更は破棄されます。続行しますか？',
    'confirm.deleteDir': 'このディレクトリと中身をすべて削除しますか？',
    'confirm.deleteFile': 'このファイルを削除しますか？',
    'menu.edit': '編集',
    'menu.undo': '元に戻す',
    'menu.redo': 'やり直す',
    'menu.cut': '切り取り',
    'menu.copy': 'コピー',
    'menu.paste': '貼り付け',
    'menu.selectAll': 'すべて選択',
    'menu.view': '表示',
    'menu.reload': '再読み込み',
    'menu.forceReload': '強制的に再読み込み',
    'menu.toggleDevTools': '開発者ツールを切り替え',
    'menu.resetZoom': '実際のサイズ',
    'menu.zoomIn': '拡大',
    'menu.zoomOut': '縮小',
    'menu.toggleFullscreen': '全画面表示の切り替え',
    'ui.dragToResize': 'ドラッグでサイズ変更',
    'menu.restartTerminal': 'ターミナルを再起動',
    'menu.help': 'ヘルプ',
    'menu.about': 'WSL Workbench について',
    'about.currentVersion': '現在のバージョン',
    'about.latestVersion': '最新バージョン',
    'about.upToDate': '最新バージョンを使用しています。',
    'about.updateAvailable': '新しいバージョンがあります。',
    'about.openReleasePage': 'リリースページを開く',
    'about.checkFailed': '最新バージョンの確認に失敗しました。',
    'about.close': '閉じる',
    'terminal.exited': '[ターミナルが終了しました]',
    'terminal.restartHint': '[Enter キーでターミナルを再起動します]',
    'claude.notFound': 'エラー: WSL の PATH に claude が見つかりません（/mnt 配下の Windows 版を除く）。WSL 内でインストールしてください: npm i -g @anthropic-ai/claude-code'
  }
};

const SUPPORTED_LANGS = ['en', 'ja'];

function normalizeLang(lang) {
  return SUPPORTED_LANGS.includes(lang) ? lang : 'en';
}

// Translate a key for a language, falling back to English then the raw key.
function t(lang, key) {
  const l = normalizeLang(lang);
  return (translations[l] && translations[l][key]) || translations.en[key] || key;
}

const i18nApi = { translations, t, normalizeLang, SUPPORTED_LANGS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = i18nApi; // main process: require('./i18n')
}
if (typeof window !== 'undefined') {
  window.i18n = i18nApi; // renderer: <script src="./i18n.js">
}
})();
