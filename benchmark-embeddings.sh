#!/bin/bash
# Benchmark OpenRouter embedding models
# Usage: OPENROUTER_API_KEY=your_key bash benchmark-embeddings.sh

if [ -z "$OPENROUTER_API_KEY" ]; then
  echo "Error: Set OPENROUTER_API_KEY environment variable"
  exit 1
fi

MODELS=(
  "openai/text-embedding-3-small"
  "openai/text-embedding-3-large"
  "openai/text-embedding-ada-002"
)

# Short and long test inputs
SHORT_INPUT="A friendly conversation about cooking recipes and Italian food"
LONG_INPUT="This is a longer passage that simulates a typical chat summary. The user and assistant discussed various topics including machine learning, natural language processing, and how transformer architectures work. They covered attention mechanisms, tokenization strategies, and the differences between encoder and decoder models. The conversation then shifted to practical applications like chatbots, code generation, and creative writing assistance. Overall it was a detailed technical discussion spanning multiple domains of AI research and application development."

echo "=========================================="
echo "OpenRouter Embedding Model Benchmark"
echo "=========================================="
echo ""

for MODEL in "${MODELS[@]}"; do
  echo "--- $MODEL ---"
  
  # Short input (3 runs, report each + average)
  echo "  Short input (~10 words):"
  SHORT_TOTAL=0
  SHORT_DIMS=""
  for i in 1 2 3; do
    RESULT=$(curl -s -w "\n%{time_total}" \
      https://openrouter.ai/api/v1/embeddings \
      -H "Authorization: Bearer $OPENROUTER_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$MODEL\",\"input\":\"$SHORT_INPUT\"}")
    
    TIME=$(echo "$RESULT" | tail -1)
    BODY=$(echo "$RESULT" | sed '$d')
    
    if [ -z "$SHORT_DIMS" ]; then
      SHORT_DIMS=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['data'][0]['embedding']))" 2>/dev/null || echo "?")
    fi
    
    echo "    Run $i: ${TIME}s"
    SHORT_TOTAL=$(echo "$SHORT_TOTAL + $TIME" | bc)
  done
  SHORT_AVG=$(echo "scale=3; $SHORT_TOTAL / 3" | bc)
  echo "    Avg: ${SHORT_AVG}s | Dims: $SHORT_DIMS"
  
  # Long input (3 runs)
  echo "  Long input (~100 words):"
  LONG_TOTAL=0
  for i in 1 2 3; do
    RESULT=$(curl -s -w "\n%{time_total}" \
      https://openrouter.ai/api/v1/embeddings \
      -H "Authorization: Bearer $OPENROUTER_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$MODEL\",\"input\":\"$LONG_INPUT\"}")
    
    TIME=$(echo "$RESULT" | tail -1)
    echo "    Run $i: ${TIME}s"
    LONG_TOTAL=$(echo "$LONG_TOTAL + $TIME" | bc)
  done
  LONG_AVG=$(echo "scale=3; $LONG_TOTAL / 3" | bc)
  echo "    Avg: ${LONG_AVG}s"
  echo ""
done

echo "=========================================="
echo "Done. Remember to delete this script after."
echo "=========================================="
