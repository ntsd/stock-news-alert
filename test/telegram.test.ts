import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAlertService } from '../src/services/telegram.js';

describe('TelegramAlertService Graceful Degradation', () => {
  it('should disable service when credentials are not provided and no-op without error', async () => {
    const disabledService = new TelegramAlertService();
    assert.equal(disabledService.isEnabled, false);

    // Should resolve safely without throwing
    await disabledService.sendAlert('<b>Test alert</b>');
    await disabledService.sendVoiceAlert(Buffer.from('mock-audio'), '<b>Voice caption</b>');
  });

  it('should enable service when both botToken and chatId are provided', () => {
    const enabledService = new TelegramAlertService('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '123456789');
    assert.equal(enabledService.isEnabled, true);
  });
});
