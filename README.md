# Myasp メールマガジン変換ツール

マークダウンファイルをMyaspメールマガジン用HTML形式に変換するPythonスクリプトです。

## 機能

- マークダウンファイルをMyasp用HTML形式に変換
- 見出し（# ##）、段落、リストをサポート
- バッチ処理で複数ファイルを一括変換
- Myaspのbody内容のみを出力（HTML/HEAD/BODYタグなし）

## 必要環境

- Python 3.6以上

## ディレクトリ構成

```
myasp-mail-magazine/
├── convert_md_to_myasp.py  # 変換スクリプト
├── md/                     # マークダウンファイル格納フォルダ
│   └── *.md
├── html/                   # HTML出力フォルダ
│   └── *.html
└── README.md
```

## 使用方法

### 1. バッチ処理（推奨）

`md/`フォルダ内の全マークダウンファイルを`html/`フォルダに一括変換：

```bash
python convert_md_to_myasp.py
```

または

```bash
python convert_md_to_myasp.py -b
```

### 2. 単一ファイル変換

特定のマークダウンファイルを変換：

```bash
# 標準出力に表示
python convert_md_to_myasp.py input.md

# ファイルに出力
python convert_md_to_myasp.py input.md -o output.html
```

## マークダウン記法サポート

### 見出し
```markdown
# メインタイトル（H1）
## サブタイトル（H2）
```

### 段落
```markdown
通常の段落テキストです。
```

### リスト
```markdown
- リスト項目1
- リスト項目2
- リスト項目3
```

### リンク
```markdown
[リンクテキスト](https://example.com)
```

### 強調
```markdown
**太字**
*斜体*
```

## 出力例

入力（マークダウン）：
```markdown
# タイトル

## セクション

本文です。

- 項目1
- 項目2
```

出力（HTML）：
```html
<h1>タイトル</h1>
<h2>セクション</h2>
<p>本文です。</p>
<ul>
<li>項目1</li>
<li>項目2</li>
</ul>
```

## Myaspでの使用方法

1. `md/`フォルダにマークダウンファイルを配置
2. `python convert_md_to_myasp.py` を実行
3. `html/`フォルダに生成されたHTMLファイルを開く
4. 内容をコピーしてMyaspのメールマガジン編集画面に貼り付け

## 注意事項

- ファイルはUTF-8エンコーディングで保存してください
- 生成されるHTMLはbody内容のみです（HTML/HEAD/BODYタグは含まれません）
- 画像や複雑なHTMLタグはサポートしていません