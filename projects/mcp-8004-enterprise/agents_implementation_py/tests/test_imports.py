import importlib
import pytest

MODULES = [
    "shared.abis", "shared.prompt_hash", "shared.vault_signer",
    "shared.bounds_monitor_client", "shared.bridge_base",
    "servers.server_base", "servers.aml_server", "servers.credit_risk_server",
    "servers.legal_server", "servers.client_setup_server",
    "servers.hf_document_server", "servers.hf_credit_negotiator_server",
    "servers.hf_legal_server", "servers.onboarding_orchestrator_server",
    "bridges.aml_bridge", "bridges.credit_risk_bridge", "bridges.legal_bridge",
    "bridges.client_setup_bridge", "bridges.hf_document_bridge",
    "bridges.hf_credit_negotiator_bridge", "bridges.hf_legal_bridge",
    "bridges.onboarding_orchestrator_bridge",
    "graph.onboarding_state", "graph.onboarding_graph",
    "graph.nodes.initiate_node", "graph.nodes.aml_node",
    "graph.nodes.credit_node", "graph.nodes.legal_node",
    "graph.nodes.client_setup_node",
]


@pytest.mark.parametrize("module", MODULES)
def test_module_imports(module):
    importlib.import_module(module)
