#!/bin/bash
# Quick Start Script for SPIRE-integrated OpenEAGO Registry

set -e

WORKDIR="./examples/agent-registry"
cd "$WORKDIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  OpenEAGO Registry + SPIRE Quick Start        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Check if SPIRE is already running
if pgrep -f "spire-server run" > /dev/null && pgrep -f "spire-agent run" > /dev/null; then
    echo -e "${GREEN}✓ SPIRE is already running${NC}"
else
    echo -e "${YELLOW}Starting SPIRE...${NC}"

    # Start SPIRE server
    spire-server run -config ~/spire/conf/server/server.conf > /tmp/spire-server.log 2>&1 &
    echo -e "${YELLOW}Waiting for SPIRE server to be ready...${NC}"
    sleep 3

    # Generate join token and start agent
    TOKEN=$(spire-server token generate -spiffeID spiffe://example.org/agent | awk '{print $2}')
    echo -e "${GREEN}✓ Join token generated${NC}"
    spire-agent run -config ~/spire/conf/agent/agent.conf -joinToken "$TOKEN" > /tmp/spire-agent.log 2>&1 &

    echo -e "${YELLOW}Waiting for SPIRE agent to be ready...${NC}"
    # Wait up to 30 seconds for the socket to be available
    for i in {1..30}; do
        if [ -S "/tmp/spire-agent/public/api.sock" ]; then
            echo -e "${GREEN}✓ SPIRE agent socket ready${NC}"
            break
        fi
        echo -n "."
        sleep 1
    done
    echo ""
    if [ ! -S "/tmp/spire-agent/public/api.sock" ]; then
        echo -e "${RED}✗ SPIRE agent socket not available after 30 seconds${NC}"
        echo "Check logs: tail -f /tmp/spire-agent.log"
        exit 1
    fi
fi

# Register workload entry (delete stale entries, then create fresh)
echo ""
echo -e "${YELLOW}Registering workload entry...${NC}"

AGENT_ID=$(spire-server agent list 2>/dev/null | grep "SPIFFE ID" | awk '{print $NF}' | head -1)
if [ -z "$AGENT_ID" ]; then
    echo -e "${RED}✗ Could not determine agent SPIFFE ID${NC}"
    exit 1
fi
echo "  Agent ID: $AGENT_ID"

# Remove all existing entries for this SPIFFE ID (clears stale parent IDs / wrong selectors)
spire-server entry show -spiffeID spiffe://example.org/agent 2>/dev/null \
    | grep "^Entry ID" | awk '{print $NF}' \
    | while read -r ENTRY_ID; do
        echo "  Deleting stale entry: $ENTRY_ID"
        spire-server entry delete -entryID "$ENTRY_ID" 2>/dev/null || true
    done

# Create fresh entry with unix:uid selector so the Workload API can match it
spire-server entry create \
    -spiffeID spiffe://example.org/agent \
    -parentID "$AGENT_ID" \
    -selector unix:uid:"$(id -u)"
echo -e "${GREEN}✓ Workload entry registered (uid=$(id -u))${NC}"

# Give the agent a moment to sync the new entry
sleep 3

# Fetch SVID
echo ""
echo -e "${YELLOW}Fetching SPIRE SVID...${NC}"
spire-agent api fetch x509 -socketPath /tmp/spire-agent/public/api.sock -write /tmp

if [ -f "/tmp/svid.0.pem" ]; then
    echo -e "${GREEN}✓ SVID fetched successfully${NC}"
else
    echo -e "${RED}✗ Failed to fetch SVID${NC}"
    exit 1
fi

# Build registry
echo ""
echo -e "${YELLOW}Building registry...${NC}"
cargo build --release

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}Setup complete! Ready to start services.${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""
echo "Next steps:"
echo ""
echo -e "${BLUE}1. Start the registry (bootstrap server):${NC}"
echo "   cargo run --release -- --config config.bootstrap.yaml"
echo ""
echo -e "${BLUE}2. Start mini agent (in another terminal):${NC}"
echo "   cd test && python3 mini_agent.py"
echo ""
echo -e "${BLUE}3. Run tests:${NC}"
echo "   ./test_spire_integration.sh"
echo ""
echo -e "${BLUE}4. Quick curl test:${NC}"
echo '   curl -X GET https://localhost:8443/health \'
echo '     --cert /tmp/svid.0.pem \'
echo '     --key /tmp/svid.0.key \'
echo '     --cacert /tmp/bundle.0.pem \'
echo '     --insecure -s | jq'
echo ""
echo -e "${YELLOW}Note: --insecure skips hostname verification, which is required${NC}"
echo -e "${YELLOW}because SPIFFE SVIDs use URI SANs (spiffe://...), not DNS SANs.${NC}"
echo -e "${YELLOW}The CA trust (--cacert) is still enforced.${NC}"
echo ""
echo -e "${YELLOW}See SPIRE_TESTING_GUIDE.md for more examples${NC}"
echo ""
