import express from 'express';
import { chromium } from 'playwright';
import fetch from 'node-fetch'; // node-fetch is for older Node.js versions, built-in fetch is better for Node 18+

// --- Environment Variables ---
// IMPORTANT: DO NOT HARDCODE THESE IN PRODUCTION. Use Render's environment variables.
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
        // *** CRITICAL CHANGE FOR DEPLOYMENT ***
        // headless: true is required for cloud environments like Render
        browser = await chromium.launch({ headless: true });
    } catch (err) {
        console.error('Failed to launch browser:', err);
        throw err;
    }

    const context = await browser.newContext();

    // WARNING: Automating a user account (self-botting) is against Discord's ToS.
    // This method can lead to your account being banned.
    // A proper Discord bot via their API is the recommended and safer approach.
    await context.addInitScript(token => {
        window.localStorage.setItem('token', `"${token}"`);
    }, DISCORD_TOKEN);

    const page = await context.newPage();
    await page.goto(`https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}`);
    await page.waitForTimeout(6000); // Wait for Discord to load

    const messages = await page.$$('[data-list-item-id^="chat-messages"]');
    if (!messages.length) {
        console.log('No messages found.');
        await browser.close();
        return;
    }

    const latest = messages[messages.length - 1];
    let prompt;
    try {
        prompt = await latest.$eval('[class*="markup"]', el => el.innerText);
    } catch (e) {
        console.error('Could not find prompt element in the latest message:', e);
        await browser.close();
        return;
    }

    const cleanedPrompt = prompt
        .replace(/\/imagine prompt\s*/i, '')
        .replace(/[\[\]]/g, '')
        .trim();

    console.log(`Processing prompt: "${cleanedPrompt}"`);

    await page.click('[role="textbox"]');
    await page.keyboard.type('/imagine');
    await page.waitForTimeout(3000); // Wait for Discord command suggestions
    await page.keyboard.press('Enter');
    await page.keyboard.type(' ' + cleanedPrompt);
    await page.keyboard.press('Enter');
    console.log('Prompt sent to Midjourney.');

    let mjMessage;
    const timeout = Date.now() + 120000; // 2 minutes timeout for initial reply

    while (Date.now() < timeout) {
        const messages = await page.$$('[data-list-item-id^="chat-messages"]');
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const text = await msg.innerText().catch(() => '');
            // Check if message contains the prompt and is from Midjourney (heuristic)
            if (text.toLowerCase().includes(cleanedPrompt.toLowerCase()) && text.includes('Midjourney Bot')) {
                mjMessage = msg;
                break;
            }
        }
        if (mjMessage) {
            console.log('MidJourney initial reply found.');
            break;
        }
        await page.waitForTimeout(5000); // Wait longer before re-checking for messages
    }

    if (!mjMessage) {
        console.error('❌ Timeout: No MidJourney reply found for the prompt within 2 minutes.');
        await browser.close();
        return;
    }

    console.log('Waiting for image generation to complete (approx 50 seconds)...');
    await page.waitForTimeout(50000); // Wait for the image to be fully generated

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
        console.error('❌ No matching MidJourney reply found after 50s wait.');
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
        console.error('❌ U1 button not found for the generated image.');
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
                // Heuristic to try and get the latest *full size* upscaled image
                // Discord often adds width/height parameters; remove them for original
                upscaleImageUrl = src
                    .replace(/([&?])(width|height)=\d+&?/g, '$1')
                    .replace(/[&?]$/, ''); // Remove trailing & or ?

                // Ensure it's a PNG and lossless for quality
                upscaleImageUrl += upscaleImageUrl.includes('?')
                    ? '&format=png&quality=lossless'
                    : '?format=png&quality=lossless';
                break;
            }
        }
        if (upscaleImageUrl) break;
    }

    if (!upscaleImageUrl) {
        console.error('❌ No upscaled image URL found.');
        await browser.close();
        return;
    }

    console.log('📤 Sending image URL to Make.com...');
    try {
        const response = await fetch(MAKE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageUrl: upscaleImageUrl, prompt: cleanedPrompt }), // Include prompt for context
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
    // Start the Midjourney process in the background
    runMidjourney().catch(err => console.error('Error in runMidjourney:', err));
    // Immediately send a response to the webhook to prevent timeout
    res.status(200).send('Midjourney script initiated. Check logs for progress.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});