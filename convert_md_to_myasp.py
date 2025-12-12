#!/usr/bin/env python3
"""
マークダウンファイルをMyaspメールマガジン用HTML形式に変換するスクリプト
"""

import re
import sys
import argparse
from pathlib import Path
import glob
import os

# メールマガジンフッター設定（変更可能）
EMAIL_FOOTER = """<br>
<p>===</p>
<p>メルマガの配信解除はこちらから</p>
<p>%cancelurl%</p>"""


def convert_markdown_to_myasp_html(markdown_content):
    """
    マークダウンをMyaspメールマガジン用HTML形式に変換
    """
    # Myasp用のbody内容のみを生成
    html_output = []

    # マークダウンを行ごとに処理
    lines = markdown_content.split('\n')
    
    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # 空行の処理
        if not line:
            # 空行が1つでも<br>を挿入
            html_output.append('<br>')
            # 連続する空行をスキップ
            while i + 1 < len(lines) and not lines[i + 1].strip():
                i += 1
            i += 1
            continue

        # H1見出しの処理（省略）
        if line.startswith('# '):
            # H1は執筆者のメモなので出力しない
            i += 1
            continue

        # H2見出しの処理
        elif line.startswith('## '):
            subtitle = line[3:].strip()
            html_output.append('<hr>')
            html_output.append(f'<br><h3>{subtitle}</h3>')

        # H3見出しの処理
        elif line.startswith('### '):
            subtitle = line[4:].strip()
            html_output.append(f'<br><h4>{subtitle}</h4>')

        # リスト項目の処理
        elif line.startswith('- '):
            item = line[2:].strip()
            # リンクがある場合の処理
            item = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', item)
            html_output.append(f'<p>・{item}</p>')

        # 改行タグの処理
        elif line == '<br>':
            html_output.append('<br>')

        # 通常の段落
        else:
            # リンクがある場合の処理
            line = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', line)
            # 強調テキストの処理
            line = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', line)
            line = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', line)

            
            html_output.append(f'<p>{line}</p>')
        
        i += 1

    # フッターを追加
    html_output.append(EMAIL_FOOTER)

    return '\n'.join(html_output)


def convert_single_file(input_file, output_file=None):
    """単一ファイルを変換"""
    input_path = Path(input_file)
    if not input_path.exists():
        print(f"エラー: ファイルが見つかりません: {input_file}", file=sys.stderr)
        return False

    try:
        with open(input_path, 'r', encoding='utf-8') as f:
            markdown_content = f.read()
    except Exception as e:
        print(f"エラー: ファイルの読み込みに失敗しました: {e}", file=sys.stderr)
        return False

    # HTML変換
    html_content = convert_markdown_to_myasp_html(markdown_content)

    # 出力
    if output_file:
        try:
            # 出力ディレクトリが存在しない場合は作成
            output_path = Path(output_file)
            output_path.parent.mkdir(parents=True, exist_ok=True)

            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(html_content)
            print(f"変換完了: {output_file}")
            return True
        except Exception as e:
            print(f"エラー: ファイルの書き込みに失敗しました: {e}", file=sys.stderr)
            return False
    else:
        print(html_content)
        return True


def convert_batch():
    """md/フォルダ内の全てのマークダウンファイルをhtml/フォルダに変換"""
    md_dir = Path("md")
    html_dir = Path(".html")

    if not md_dir.exists():
        print(f"エラー: mdディレクトリが見つかりません: {md_dir}", file=sys.stderr)
        return False

    # html ディレクトリを作成
    html_dir.mkdir(exist_ok=True)

    # md フォルダ内の .md ファイルを検索
    md_files = list(md_dir.glob("*.md"))

    if not md_files:
        print("変換対象のマークダウンファイルが見つかりません")
        return True

    success_count = 0
    total_count = len(md_files)

    for md_file in md_files:
        # 出力ファイル名を生成（拡張子を .html に変更）
        html_file = html_dir / (md_file.stem + ".html")

        if convert_single_file(md_file, html_file):
            success_count += 1

    print(f"\nバッチ変換完了: {success_count}/{total_count} ファイル")
    return success_count == total_count


def main():
    parser = argparse.ArgumentParser(description='マークダウンファイルをMyaspメールマガジン用HTML形式に変換')
    parser.add_argument('input_file', nargs='?', help='入力マークダウンファイル（指定しない場合はバッチ処理）')
    parser.add_argument('-o', '--output', help='出力HTMLファイル（指定しない場合は標準出力）')
    parser.add_argument('-b', '--batch', action='store_true', help='md/フォルダ内の全ファイルをhtml/フォルダに変換')

    args = parser.parse_args()

    # バッチ処理の場合
    if args.batch or not args.input_file:
        success = convert_batch()
        sys.exit(0 if success else 1)

    # 単一ファイル処理の場合
    success = convert_single_file(args.input_file, args.output)
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()