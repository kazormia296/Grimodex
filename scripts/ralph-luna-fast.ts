import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('before_provider_request', ({ payload }) => {
    if (payload && typeof payload === 'object' && 'model' in payload && payload.model === 'gpt-6-luna') {
      return { ...payload, service_tier: 'priority' };
    }
  });
}
