import { describe, it, expect } from 'vitest';
import { rockPeopleTool } from './rock-people.js';
import { RockClientImpl } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';

describe('rock_people Integration Test', () => {
  const hasEnv = !!(process.env.ROCK_PUBLIC_URL && process.env.ROCK_API_KEY);

  it.runIf(hasEnv)('should find people on the live preview server', async () => {
    const client = new RockClientImpl({
      baseUrl: process.env.ROCK_PUBLIC_URL!,
      apiKey: process.env.ROCK_API_KEY!,
    });

    const mockCtx = {
      mode: 'readonly',
      scopes: new Set(['read']),
      request: {
        requestId: 'people-int-req-123',
        sessionId: 'people-int-sess-456',
      },
      rockClient: client,
    } as unknown as OAuthRockContext;

    // Call find for people with a common search term, e.g. "Admin" or "Favor"
    const result = await rockPeopleTool.handle(
      { action: 'find', query: 'Admin' },
      null,
      mockCtx
    );

    expect(result).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(Array.isArray(response.result)).toBe(true);
  });

  it.runIf(hasEnv)('should create/update phone number on a test person and clean up', async () => {
    const client = new RockClientImpl({
      baseUrl: process.env.ROCK_PUBLIC_URL!,
      apiKey: process.env.ROCK_API_KEY!,
    });

    const ctx = {
      mode: 'readwrite',
      scopes: new Set(['read', 'write']),
      request: {
        requestId: 'people-phone-int-req-' + Date.now(),
        sessionId: 'people-phone-int-sess-' + Date.now(),
      },
      rockClient: client,
      oauth: { subject: 'test-user' },
      rockUser: { personId: 1, isRsrAdmin: false },
    } as unknown as OAuthRockContext;

    // Find or create a test person (use Admin or search for a known test account)
    const findResult = await rockPeopleTool.handle(
      { action: 'find', query: 'Admin' },
      null,
      { ...ctx, mode: 'readonly', scopes: new Set(['read']) } as OAuthRockContext
    );
    const findResponse = JSON.parse(findResult.content[0].text!);
    if (!findResponse.ok || !Array.isArray(findResponse.result) || findResponse.result.length === 0) {
      throw new Error('Could not find test person for phone update integration test');
    }
    const testPersonId = findResponse.result[0].id;

    // Store original phone for cleanup
    let originalPhoneId: number | null = null;
    let originalPhoneNumber: string | null = null;
    try {
      const phoneNumbers = await client.get<any[]>(ctx, `/api/PhoneNumbers?$filter=PersonId eq ${testPersonId}`);
      if (phoneNumbers && phoneNumbers.length > 0) {
        const mobilePhone = phoneNumbers.find((p: any) => p.NumberTypeValueId === 1 || p.NumberType?.Value === 'Mobile');
        if (mobilePhone) {
          originalPhoneId = mobilePhone.Id;
          originalPhoneNumber = mobilePhone.Number;
        }
      }
    } catch {
      // Ignore if can't fetch original
    }

    // Test: update phone to new test number (max 20 chars)
    const testPhoneNumber = '+1555' + Date.now().toString().slice(-6);
    const updateResult = await rockPeopleTool.handle(
      {
        action: 'updateContactInfo',
        personId: testPersonId,
        phone: testPhoneNumber,
        dryRun: false,
        commit: true,
        reason: 'integration test phone update',
      },
      null,
      ctx
    );

    const updateResponse = JSON.parse(updateResult.content[0].text!);
    if (!updateResponse.ok) {
      console.error('Update failed:', updateResponse.error);
    }
    expect(updateResponse.ok).toBe(true);
    expect(updateResponse.result.committed).toBe(true);

    // Verify the phone number was actually created/updated in the API
    const phoneNumbers = await client.get<any[]>(ctx, `/api/PhoneNumbers?$filter=PersonId eq ${testPersonId}`);
    // Rock stores phone numbers in a normalized format (digits only)
    const normalizedTest = testPhoneNumber.replace(/\D/g, '');
    const updatedPhone = phoneNumbers?.find((p: any) => p.Number === normalizedTest);
    expect(updatedPhone).toBeDefined();
    expect(updatedPhone?.Number).toBe(normalizedTest);

    // Cleanup: restore original or delete test phone
    try {
      if (originalPhoneId && originalPhoneNumber) {
        // Restore original
        await client.patch(ctx, `/api/PhoneNumbers/${updatedPhone!.Id}`, { Number: originalPhoneNumber });
      } else {
        // Delete the test phone we just created
        await client.delete(ctx, `/api/PhoneNumbers/${updatedPhone!.Id}`);
      }
    } catch (cleanupErr) {
      console.warn('Integration test cleanup warning:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
      // Don't fail the test on cleanup errors
    }
  });
});
