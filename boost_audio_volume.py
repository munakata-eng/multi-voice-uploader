#!/usr/bin/env python3
"""
m4aファイルの音声ボリュームを上げるスクリプト
"""

import subprocess
import sys
import argparse
from pathlib import Path

def boost_audio_volume(input_file, output_file=None, volume_factor=2.0):
    """
    音声ファイルのボリュームを上げる
    
    Args:
        input_file: 入力ファイルパス
        output_file: 出力ファイルパス（指定しない場合は自動生成）
        volume_factor: ボリューム倍率（デフォルト: 2.0）
    """
    input_path = Path(input_file)
    
    # 入力ファイルの存在確認
    if not input_path.exists():
        print(f"エラー: ファイルが見つかりません: {input_file}", file=sys.stderr)
        return False
    
    # 出力ファイル名の生成
    if output_file is None:
        stem = input_path.stem
        suffix = input_path.suffix
        output_path = input_path.parent / f"{stem}_boosted{suffix}"
    else:
        output_path = Path(output_file)
    
    # FFmpegコマンドの構築
    cmd = [
        'ffmpeg',
        '-i', str(input_path),
        '-filter:a', f'volume={volume_factor}',
        '-y',  # 出力ファイルを上書き
        str(output_path)
    ]
    
    try:
        print(f"処理中: {input_path} → {output_path}")
        print(f"ボリューム倍率: {volume_factor}")
        
        # FFmpegを実行
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode == 0:
            print(f"完了: {output_path}")
            return True
        else:
            print(f"エラー: FFmpegの実行に失敗しました", file=sys.stderr)
            print(f"エラー内容: {result.stderr}", file=sys.stderr)
            return False
            
    except FileNotFoundError:
        print("エラー: FFmpegがインストールされていません", file=sys.stderr)
        print("Homebrewでインストールしてください: brew install ffmpeg", file=sys.stderr)
        return False
    except Exception as e:
        print(f"エラー: {e}", file=sys.stderr)
        return False

def boost_batch(directory=".", volume_factor=2.0):
    """
    指定ディレクトリ内の全m4aファイルのボリュームを上げる
    """
    dir_path = Path(directory)
    
    if not dir_path.exists():
        print(f"エラー: ディレクトリが見つかりません: {directory}", file=sys.stderr)
        return False
    
    # m4aファイルを検索
    m4a_files = list(dir_path.glob("*.m4a"))
    
    if not m4a_files:
        print(f"m4aファイルが見つかりません: {directory}")
        return True
    
    success_count = 0
    total_count = len(m4a_files)
    
    print(f"{total_count}個のm4aファイルを処理します...")
    
    for m4a_file in m4a_files:
        # _boostedが既に含まれているファイルはスキップ
        if "_boosted" in m4a_file.stem:
            print(f"スキップ: {m4a_file} (既にブーストされたファイル)")
            continue
            
        if boost_audio_volume(m4a_file, volume_factor=volume_factor):
            success_count += 1
    
    print(f"\nバッチ処理完了: {success_count}/{total_count} ファイル")
    return success_count == total_count

def main():
    parser = argparse.ArgumentParser(description='m4aファイルの音声ボリュームを上げる')
    parser.add_argument('input_file', nargs='?', help='入力m4aファイル（指定しない場合はバッチ処理）')
    parser.add_argument('-o', '--output', help='出力ファイル名（指定しない場合は自動生成）')
    parser.add_argument('-v', '--volume', type=float, default=2.0, help='ボリューム倍率（デフォルト: 2.0）')
    parser.add_argument('-b', '--batch', action='store_true', help='カレントディレクトリ内の全m4aファイルを処理')
    parser.add_argument('-d', '--directory', default='.', help='バッチ処理対象ディレクトリ（デフォルト: カレントディレクトリ）')
    
    args = parser.parse_args()
    
    # バッチ処理の場合
    if args.batch or not args.input_file:
        success = boost_batch(args.directory, args.volume)
        sys.exit(0 if success else 1)
    
    # 単一ファイル処理の場合
    success = boost_audio_volume(args.input_file, args.output, args.volume)
    sys.exit(0 if success else 1)

if __name__ == '__main__':
    main()