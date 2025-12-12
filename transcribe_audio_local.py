#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ローカルWhisperを使用してオーディオファイルを文字起こしするスクリプト
"""

import os
import sys
import argparse
from pathlib import Path
import whisper

# Windowsで標準出力のエンコーディングをUTF-8に設定
if sys.platform == 'win32':
    import io
    # 標準出力と標準エラー出力をUTF-8に設定
    if sys.stdout.encoding != 'utf-8':
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    if sys.stderr.encoding != 'utf-8':
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')


def transcribe_audio_file(audio_file_path, output_dir=None, model_name="base"):
    """
    単一のオーディオファイルを文字起こし

    Args:
        audio_file_path: オーディオファイルのパス
        output_dir: 出力ディレクトリ（指定しない場合は標準出力）
        model_name: Whisperモデル名（tiny, base, small, medium, large）

    Returns:
        bool: 成功時True、失敗時False
    """
    try:
        # パスを正規化
        audio_file_path = os.path.normpath(os.path.abspath(audio_file_path))
        
        # 入力ファイルの存在確認（念のため再確認）
        if not os.path.exists(audio_file_path):
            print(f"エラー: 入力ファイルが見つかりません: {audio_file_path}", file=sys.stderr)
            return False

        # 出力先でファイルの存在確認
        if output_dir:
            output_dir = os.path.normpath(os.path.abspath(output_dir))
            audio_path = Path(audio_file_path)
            output_file = Path(output_dir) / f"{audio_path.stem}.txt"

            # 既にファイルが存在する場合はスキップ
            if output_file.exists():
                print(f"スキップ: {output_file} は既に存在します")
                return True

        print(f"Whisperモデル '{model_name}' を読み込み中...")
        model = whisper.load_model(model_name)

        print(f"文字起こしを実行中: {audio_file_path}")
        result = model.transcribe(audio_file_path, language="ja")

        transcript_text = result["text"].strip()

        # 出力処理
        if output_dir:
            # 出力ディレクトリが存在しない場合は作成
            output_file.parent.mkdir(parents=True, exist_ok=True)

            # テキスト形式で保存
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(transcript_text)

            print(f"文字起こし完了: {output_file}")
            return True
        else:
            print(transcript_text)
            return True

    except Exception as e:
        print(f"エラー: {audio_file_path} の文字起こしに失敗しました: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description='ローカルWhisperを使用してオーディオファイルを文字起こし')
    parser.add_argument('input_file', help='入力オーディオファイル')
    parser.add_argument('-o', '--output', help='出力ディレクトリ（指定しない場合は標準出力）')
    parser.add_argument('-m', '--model', default='base',
                        choices=['tiny', 'base', 'small', 'medium', 'large'],
                        help='Whisperモデル名（デフォルト: base）')

    args = parser.parse_args()

    # パスを正規化（Windowsのパス区切り文字の問題を回避）
    input_file_path = os.path.normpath(os.path.abspath(args.input_file))
    if args.output:
        output_dir = os.path.normpath(os.path.abspath(args.output))
    else:
        output_dir = None

    # 入力ファイルの存在確認
    if not os.path.exists(input_file_path):
        print(f"エラー: 入力ファイルが見つかりません: {input_file_path}", file=sys.stderr)
        sys.exit(1)

    # 単一ファイル処理
    success = transcribe_audio_file(input_file_path, output_dir, args.model)
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()

