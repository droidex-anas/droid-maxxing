import { createSdkMcpServer } from '@factory/droid-sdk';
import { createAutomationMcpTools } from './automationMcpTools.js';
import { AUTOMATION_MCP_SERVER_NAME } from './permissionPolicy.js';

export function createAutomationMcpServer(appSessionIdForTool: () => string | undefined) {
  const appSessionId = () => {
    const id = appSessionIdForTool();
    if (!id) throw new Error('Automation tools are not attached to a live DROIDEX session yet.');
    return id;
  };

  return createSdkMcpServer({
    name: AUTOMATION_MCP_SERVER_NAME,
    version: '1.0.0',
    tools: createAutomationMcpTools({ appSessionId }),
  });
}
