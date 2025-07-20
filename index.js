import express from 'express';
import { chromium } from 'playwright';
// Removed node-fetch import as Node.js 18+ has native fetch.
// If you are using an older Node.js version, keep it.

// --- Environment Variables ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SERVER_ID = process.env.DISCORD_SERVER_ID;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

const app = express();
app.use(express.json());

async function runMidjourney() {
    let browser;
    try {
        console.log('Launching browser...');
        browser = await chromium.launch({ headless: true });
    } catch (err) {
        console.error('Failed to launch browser:', err);
        throw err;
    }

    const context = await browser.newContext();

    // WARNING: Automating a user account (self-botting) is against Discord's ToS.
    // This method can lead to your account being banned.
    // A proper Discord bot via their API is the recommended and safer approach.
    try {
        await context.addInitScript(token => {
            window.localStorage.setItem('token', `"${token}"`);
        }, DISCORD_TOKEN);
        console.log('Discord token injected into local storage.');
    } catch (e) {
        console.error('Error injecting token:', e);
        await browser.close();
        return;
    }

    const page = await context.newPage();

    console.log(`Navigating to Discord channel: https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}`);
    try {
        await page.goto(`https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}`, { waitUntil: 'domcontentloaded', timeout: 60000 }); // Increased timeout
        console.log('Discord page loaded (DOM content).');

        // *** IMPORTANT DEBUGGING STEP ***
        // Log the current URL to confirm redirection issues.
        console.log('Current page URL after goto:', page.url());

        // Wait for a robust indicator that the Discord UI is ready and authenticated.
        // This is more reliable than fixed timeouts or just waiting for chat messages.
        // Look for a known, stable element that appears *after* successful login and channel load.
        // Examples: The text input box, the channel name header, or a general chat container.
        const discordUISelector = '[role="textbox"][aria-label="Message"]'; // A common robust selector for the chat input box
        console.log(`Waiting for Discord UI element: ${discordUISelector}`);
        await page.waitForSelector(discordUISelector, { timeout: 60000 }); // Wait up to 60 seconds for the UI
        console.log('Discord UI element found, likely authenticated and loaded.');

        // Take a screenshot for visual debugging (if you can retrieve it later)
        // For Render, you might need to upload this to a service like Imgur/S3 or convert to base64 and log.
        // For immediate debugging, just log the content.
        // await page.screenshot({ path: 'discord_loaded_page.png' });
        // console.log('Screenshot of loaded Discord page taken (discord_loaded_page.png).');
        console.log('Page title:', await page.title());
        // console.log('Page content (first 500 chars):\n', (await page.content()).substring(0, 500)); // Log a snippet of HTML

    } catch (err) {
        console.error('❌ Failed to load Discord page or find UI element:', err);
        // Try to get content even if failed to load for more info
        try {
            console.error('Page content on error:', (await page.content()).substring(0, 1000));
        } catch (e) { /* ignore */ }
        await browser.close();
        return;
    }

    const messages = await page.$$('[data-list-item-id^="chat-messages"]');
    if (!messages.length) {
        console.log('No messages found (after UI loaded). This might indicate the selector is outdated or no actual messages are present.');
        // Consider waiting for one message to appear explicitly if this is a common issue
        try {
             await page.waitForSelector('[data-list-item-id^="chat-messages"]', { timeout: 30000 });
             console.log('Messages container found after explicit wait.');
             const retryMessages = await page.$$('[data-list-item-id^="chat-messages"]');
             if (!retryMessages.length) {
                console.error('❌ Still no messages found after additional wait. Exiting.');
                await browser.close();
                return;
             }
        } catch (e) {
            console.error('❌ Failed to find any chat messages even after waiting:', e);
            await browser.close();
            return;
        }

    }

    const latest = messages[messages.length - 1];
    let prompt;
    try {
        prompt = await latest.$eval('[class*="markup"]', el => el.innerText);
    } catch (e) {
        console.error('Could not find prompt element in the latest message (selector [class*="markup"] might be outdated):', e);
        // Try a more general text extraction if markup fails
        try {
            prompt = await latest.innerText();
            console.log('Attempted innerText for prompt:', prompt);
        } catch (e2) {
            console.error('Failed to get any text from latest message:', e2);
        }
        await browser.close();
        return;
    }

    const cleanedPrompt = prompt
        .replace(/\/imagine prompt\s*/i, '')
        .replace(/[\[\]]/g, '')
        .trim();

    console.log(`Processing prompt: "${cleanedPrompt}"`);

    try {
        await page.click('[role="textbox"]'); // Click the chat input
        await page.keyboard.type('/imagine');
        await page.waitForTimeout(3000); // Wait for Discord command suggestions
        await page.keyboard.press('Enter'); // Select /imagine
        await page.keyboard.type(' ' + cleanedPrompt);
        await page.keyboard.press('Enter');
        console.log('Prompt sent to Midjourney.');
    } catch (e) {
        console.error('❌ Failed to type or send prompt:', e);
        await browser.close();
        return;
    }


    let mjMessage;
    const timeout = Date.now() + 120000; // 2 minutes timeout for initial reply

    while (Date.now() < timeout) {
        const currentMessages = await page.$$('[data-list-item-id^="chat-messages"]');
        for (let i = currentMessages.length - 1; i >= 0; i--) {
            const msg = currentMessages[i];
            const text = await msg.innerText().catch(() => '');
            if (text.toLowerCase().includes(cleanedPrompt.toLowerCase()) && text.includes('Midjourney Bot')) {
                mjMessage = msg;
                break;
            }
        }
        if (mjMessage) {
            console.log('MidJourney initial reply found.');
            break;
        }
        console.log('Waiting for MidJourney reply...');
        await page.waitForTimeout(5000); // Wait longer before re-checking for messages
    }

    if (!mjMessage) {
        console.error('❌ Timeout: No MidJourney reply found for the prompt within 2 minutes.');
        await browser.close();
        return;
    }

    console.log('Waiting for image generation to complete (approx 50 seconds)...');
    await page.waitForTimeout(50000); // Wait for the image to be fully generated

    // Re-fetch messages to get the updated state after 50 seconds
    const updatedMessages = await page.$$('[data-list-item-id^="chat-messages"]');
    let targetMessage = null;

    for (let i = updatedMessages.length - 1; i >= 0; i--) {
        const msgText = await updatedMessages[i].innerText().catch(() => '');
        if (msgText.toLowerCase().includes(cleanedPrompt.toLowerCase()) && msgText.includes('Midjourney Bot')) {
            targetMessage = updatedMessages[i];
            break;
        }
    }

    if (!targetMessage) {
        console.error('❌ No matching MidJourney reply found after 50s wait for generation.');
        await browser.close();
        return;
    }

    const finalMsgText = await targetMessage.innerText();
    if (!finalMsgText.toLowerCase().includes(cleanedPrompt.toLowerCase())) {
        console.error('❌ Reply doesn’t include expected prompt after 50s wait.');
        await browser.close();
        return;
    }

    // Attempt to click U1 button
    const u1Button = await targetMessage.$('button:has-text("U1")');
    if (!u1Button) {
        console.error('❌ U1 button not found for the generated image. This could mean the image is not ready or Discord UI changed.');
        await browser.close();
        return;
    }

    await u1Button.click();
    console.log('🖱️ U1 clicked. Waiting for upscale...');
    await page.waitForTimeout(10000); // Wait for the upscale process

    const allMessages = await page.$$('[data-list-item-id^="chat-messages"]');
    let upscaleImageUrl = null;

    for (let i = allMessages.length - 1; i >= 0; i--) {
        const message = allMessages[i];
        const imgs = await message.$$('img');

        for (const img of imgs) {
            const src = await img.getAttribute('src');
            if (
                src &&
                src.includes('media.discordapp.net') &&
                /\.(png|jpe?g|webp)(\?|$)/i.test(src) &&
                !src.includes('avatars') && // Exclude avatar images
                !src.includes('attachments') // Exclude small attachment previews if any
            ) {
                upscaleImageUrl = src
                    .replace(/([&?])(width|height)=\d+&?/g, '$1')
                    .replace(/[&?]$/, '');

                upscaleImageUrl += upscaleImageUrl.includes('?')
                    ? '&format=png&quality=lossless'
                    : '?format=png&quality=lossless';
                break;
            }
        }
        if (upscaleImageUrl) break;
    }

    if (!upscaleImageUrl) {
        console.error('❌ No upscaled image URL found after U1 click.');
        await browser.close();
        return;
    }

    console.log('📤 Sending image URL to Make.com...');
    try {
        const response = await fetch(MAKE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageUrl: upscaleImageUrl, prompt: cleanedPrompt }),
        });

        if (response.ok) {
            console.log('✅ Image URL sent successfully to Make.com!');
        } else {
            const errorBody = await response.text();
            console.error('❌ Failed to send to Make.com:', response.status, response.statusText, errorBody);
        }
    } catch (err) {
        console.error('❌ Error sending to Make.com:', err.message);
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
}

app.post('/trigger', async (req, res) => {
    console.log('Received webhook trigger!');
    runMidjourney().catch(err => console.error('Error in runMidjourney:', err));
    res.status(200).send('Midjourney script initiated. Check logs for progress.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
