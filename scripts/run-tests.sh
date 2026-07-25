#!/usr/bin/env bash
# TeaParty-Bell 全量测试运行器
# 运行所有 *.test.js 文件，汇总结果。
#
# 用法：bash scripts/run-tests.sh

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASSED=0
FAILED=0
FAILED_FILES=""

# 查找所有测试文件
TEST_FILES=$(find src scripts -name '*.test.js' -not -path '*/node_modules/*' | sort)

for TEST_FILE in $TEST_FILES; do
  echo ""
  echo "--- $TEST_FILE ---"
  if node "$TEST_FILE"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    FAILED_FILES="$FAILED_FILES $TEST_FILE"
  fi
done

echo ""
echo "===================================="
echo "全量测试完成"
echo "文件级: $PASSED passed / $FAILED failed"
echo "===================================="

if [ "$FAILED" -gt 0 ]; then
  echo "失败文件:$FAILED_FILES"
  exit 1
fi
