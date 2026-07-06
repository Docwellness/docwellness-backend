#!/bin/bash
#
# Test Script for OpenAI Recipe Generation API
# Usage: ./test-recipe-curl.sh
#

API_BASE="http://localhost:3000"

echo "🚀 Testing Recipe AI API..."
echo ""

# Step 1: Register/Login as dietician
echo "📝 Step 1: Logging in as dietician..."
LOGIN_RESPONSE=$(curl -s -X POST "$API_BASE/api/patient/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "testdietician@test.com",
    "password": "Test@123"
  }')

# Check if login was successful
SUCCESS=$(echo $LOGIN_RESPONSE | python3 -c "import sys, json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null)

if [ "$SUCCESS" != "True" ]; then
  echo "⚠️  Dietician not found, creating one..."

  # Register new dietician
  REGISTER_RESPONSE=$(curl -s -X POST "$API_BASE/api/patient/auth/register" \
    -H "Content-Type: application/json" \
    -d '{
      "fullName": "Test Dietician",
      "email": "testdietician@test.com",
      "password": "Test@123",
      "confirmPassword": "Test@123",
      "gender": "Male",
      "dateOfBirth": "1990-01-01"
    }')

  echo "Register response: $REGISTER_RESPONSE"

  # Try login again
  LOGIN_RESPONSE=$(curl -s -X POST "$API_BASE/api/patient/auth/login" \
    -H "Content-Type: application/json" \
    -d '{
      "email": "testdietician@test.com",
      "password": "Test@123"
    }')
fi

# Extract token
TOKEN=$(echo $LOGIN_RESPONSE | python3 -c "import sys, json; print(json.load(sys.stdin).get('token', ''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "❌ Failed to get token. Login response:"
  echo $LOGIN_RESPONSE | python3 -m json.tool 2>/dev/null || echo $LOGIN_RESPONSE
  exit 1
fi

echo "✅ Got token: ${TOKEN:0:30}..."
echo ""

# Step 2: Test AI Recipe Generation
echo "🤖 Step 2: Testing AI Recipe Generation..."
echo ""
echo "Request:"
echo '{
  "name": "Paneer Tikka",
  "servingTime": "Dinner",
  "servings": 2,
  "dietaryHabits": { "vegetarian": true },
  "freeFrom": { "sugar": true, "processedFood": true },
  "aiNote": "Make it protein rich and spicy"
}'
echo ""
echo "⏳ Calling OpenAI API (may take 10-30 seconds)..."
echo ""

START_TIME=$(date +%s)

AI_RESPONSE=$(curl -s -X POST "$API_BASE/api/dietician/recipes/ai-generate-preview" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Paneer Tikka",
    "servingTime": "Dinner",
    "servings": 2,
    "dietaryHabits": {
      "vegetarian": true,
      "vegan": false,
      "jain": false,
      "nonVegetarian": false,
      "eggitarian": false
    },
    "freeFrom": {
      "sugar": true,
      "salt": false,
      "processedFood": true,
      "oil": false
    },
    "aiNote": "Make it protein rich and spicy, use tandoori spices"
  }')

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo "✅ Response received in ${ELAPSED}s:"
echo ""
echo "─────────────────────────────────────────────────"
echo $AI_RESPONSE | python3 -m json.tool 2>/dev/null || echo $AI_RESPONSE
echo "─────────────────────────────────────────────────"
echo ""

# Check success
AI_SUCCESS=$(echo $AI_RESPONSE | python3 -c "import sys, json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null)

if [ "$AI_SUCCESS" == "True" ]; then
  echo "✅ Recipe AI API test PASSED!"

  # Print summary
  echo ""
  echo "📊 Summary:"
  echo $AI_RESPONSE | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', {})
print(f\"   Recipe: {data.get('name', 'N/A')}\")
print(f\"   Description: {data.get('description', 'N/A')[:60]}...\")
print(f\"   Calories: {data.get('nutrition', {}).get('calories', 'N/A')}\")
print(f\"   Protein: {data.get('nutrition', {}).get('protein', 'N/A')}g\")
print(f\"   Ingredients: {len(data.get('ingredients', []))}\")
print(f\"   Cooking Steps: {len(data.get('cookingSteps', []))}\")
if data.get('ingredients'):
    print()
    print('   🥗 Sample Ingredients:')
    for i, ing in enumerate(data.get('ingredients', [])[:3], 1):
        print(f\"   {i}. {ing.get('name')} - {ing.get('quantity')}{ing.get('unit')}\")
        print(f\"      Category: {ing.get('category')}, Price: {ing.get('priceLevel')}\")
        print(f\"      Description: {ing.get('description', '')[:50]}...\")
" 2>/dev/null
else
  echo "❌ Recipe AI API test FAILED!"
  exit 1
fi

echo ""
echo "🎉 All tests completed!"
