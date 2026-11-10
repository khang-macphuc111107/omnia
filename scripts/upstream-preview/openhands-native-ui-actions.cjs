module.exports = async function actions({ page, report, save, capture, until, marker }) {
  // Consent and onboarding are deliberately driven through accessible controls.
  await page.getByRole('checkbox', { name: 'Send anonymous usage data' }).uncheck();
  await page.getByRole('button', { name: 'Confirm preferences', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  report.checks.telemetryAndAgentOnboarding = true;
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await page.getByRole('textbox', { name: 'Custom Model', exact: true }).fill('openai/omnia-ui');
  await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill(report.providerBaseUrl);
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('omnia-loopback-key');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('heading', { name: /Say hello/ }).waitFor();
  report.checks.loopbackModelSaved = true;
  await page.getByRole('textbox', { name: /Say hello/ }).fill('Return the audit marker and finish.');
  // The conversation is created before the agent websocket reaches Connected.
  // Wait for the real composer gate instead of treating a disabled send button
  // as a UI failure while the backend is still attaching the agent.
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await until(async () => await send.isEnabled(), 'initial composer enabled', 120000);
  await send.click();
  await page.waitForURL(/\/conversations\//);
  report.checks.onboardingCreatedConversation = true;
  await page.getByTestId('chat-input').fill('Finish this audit using the finish tool.');
  await until(async () => await send.isEnabled(), 'conversation composer enabled', 120000);
  await send.click();
  await page.locator('article').getByText(marker, { exact: true }).last().waitFor({ timeout: 30000 });
  report.checks.nativeUiProviderResponse = true;
  await capture('conversation-response');
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByTestId('conversation-name-input').fill('Omnia OpenHands native audit');
  await page.getByTestId('conversation-name-input').press('Enter');
  await page.getByTestId('conversation-name-input').waitFor({ state: 'hidden' });
  report.checks.rename = true;
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  report.checks.deleteCanceled = await page.locator('article').getByText(marker, { exact: true }).last().isVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.waitForURL(/\/settings/);
  await page.getByText('Settings', { exact: true }).first().waitFor({ timeout: 10000 });
  report.checks.settingsNavigation = /\/settings/.test(page.url()) && (await page.locator('body').innerText()).includes('Settings');
  await capture('settings');
  save();
};
