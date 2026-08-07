// utils/mailer.js
require("dotenv").config();
const Mailjet = require("node-mailjet");

// =================== MAILJET CONFIG ===================
const mailjet = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC,
  process.env.MJ_APIKEY_PRIVATE
);

// =================== EMAIL TEMPLATES ===================
const emailTemplates = {
  otp: (otp, expiresInMins = 10, appName = "My_App") => ({
    subject: `🔐 Your ${appName} OTP: ${otp}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>OTP Verification</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f6f9fc; }
          .container { max-width: 580px; margin: 0 auto; padding: 40px 20px; }
          .card { 
            background: #ffffff; 
            border-radius: 20px; 
            padding: 40px 35px; 
            box-shadow: 0 20px 60px rgba(0,0,0,0.08);
            border: 1px solid rgba(0,0,0,0.04);
          }
          .header { text-align: center; margin-bottom: 30px; }
          .logo { 
            display: inline-flex; 
            align-items: center; 
            justify-content: center;
            width: 64px; 
            height: 64px; 
            background: linear-gradient(135deg, #7C3AED, #4F6BFF);
            border-radius: 16px;
            margin-bottom: 16px;
          }
          .logo-text { 
            font-size: 28px; 
            font-weight: 800; 
            color: #ffffff;
            letter-spacing: -0.5px;
          }
          .title { 
            font-size: 24px; 
            font-weight: 700; 
            color: #1a1a2e; 
            margin-bottom: 6px;
          }
          .subtitle { 
            font-size: 14px; 
            color: #6b7280; 
            font-weight: 400;
          }
          .otp-box {
            background: linear-gradient(135deg, #faf5ff, #f3e8ff);
            border: 2px solid #e9d5ff;
            border-radius: 16px;
            padding: 24px;
            text-align: center;
            margin: 24px 0;
          }
          .otp-code {
            font-size: 36px;
            font-weight: 800;
            letter-spacing: 8px;
            color: #7C3AED;
            font-family: 'Courier New', monospace;
            padding: 8px 16px;
            background: rgba(255,255,255,0.5);
            border-radius: 12px;
            display: inline-block;
          }
          .info-text {
            font-size: 13px;
            color: #6b7280;
            line-height: 1.6;
            margin: 16px 0;
          }
          .info-text strong { color: #1a1a2e; }
          .divider {
            height: 1px;
            background: linear-gradient(90deg, transparent, #e5e7eb, transparent);
            margin: 24px 0;
          }
          .footer {
            text-align: center;
            font-size: 12px;
            color: #9ca3af;
          }
          .footer a { color: #7C3AED; text-decoration: none; }
          .badge {
            display: inline-block;
            padding: 4px 12px;
            background: #ecfdf5;
            color: #065f46;
            border-radius: 100px;
            font-size: 12px;
            font-weight: 600;
          }
          @media (max-width: 480px) {
            .card { padding: 24px 16px; }
            .otp-code { font-size: 28px; letter-spacing: 6px; }
            .title { font-size: 20px; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <div class="header">
              <div class="logo">
                <span class="logo-text">📊</span>
              </div>
              <h1 class="title">Verify Your Email</h1>
              <p class="subtitle">Use the OTP below to complete your verification</p>
            </div>

            <div class="otp-box">
              <div style="font-size:13px; color:#6b7280; margin-bottom:8px;">Your One-Time Password</div>
              <div class="otp-code">${otp}</div>
              <div style="margin-top:10px;">
                <span class="badge">⏱️ Expires in ${expiresInMins} minutes</span>
              </div>
            </div>

            <p class="info-text">
              This OTP is valid for <strong>${expiresInMins} minutes</strong>. 
              If you didn't request this code, please ignore this email or 
              <a href="#" style="color:#7C3AED;">contact support</a>.
            </p>

            <div class="divider"></div>

            <div class="footer">
              <p>© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
              <p style="margin-top:4px;">
                <a href="#">Privacy Policy</a> • <a href="#">Terms</a> • <a href="#">Help</a>
              </p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `
  }),
  
  welcome: (name, appName = "My_App") => ({
    subject: `🎉 Welcome to ${appName}!`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f6f9fc; }
          .container { max-width: 580px; margin: 0 auto; padding: 40px 20px; }
          .card { 
            background: #ffffff; 
            border-radius: 20px; 
            padding: 40px 35px; 
            box-shadow: 0 20px 60px rgba(0,0,0,0.08);
            border: 1px solid rgba(0,0,0,0.04);
          }
          .header { text-align: center; margin-bottom: 24px; }
          .logo { 
            display: inline-flex; 
            align-items: center; 
            justify-content: center;
            width: 64px; 
            height: 64px; 
            background: linear-gradient(135deg, #22c55e, #16a34a);
            border-radius: 16px;
            margin-bottom: 16px;
          }
          .title { 
            font-size: 24px; 
            font-weight: 700; 
            color: #1a1a2e; 
            margin-bottom: 6px;
          }
          .subtitle { 
            font-size: 14px; 
            color: #6b7280; 
            font-weight: 400;
          }
          .content { 
            font-size: 14px; 
            color: #374151; 
            line-height: 1.7;
            margin: 20px 0;
          }
          .divider {
            height: 1px;
            background: linear-gradient(90deg, transparent, #e5e7eb, transparent);
            margin: 24px 0;
          }
          .footer {
            text-align: center;
            font-size: 12px;
            color: #9ca3af;
          }
          .btn {
            display: inline-block;
            padding: 12px 32px;
            background: linear-gradient(135deg, #7C3AED, #4F6BFF);
            color: #ffffff;
            border-radius: 12px;
            text-decoration: none;
            font-weight: 600;
            margin: 8px 0;
          }
          @media (max-width: 480px) {
            .card { padding: 24px 16px; }
            .title { font-size: 20px; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <div class="header">
              <div class="logo">
                <span style="font-size:28px;">🎉</span>
              </div>
              <h1 class="title">Welcome${name ? `, ${name}!` : ''}</h1>
              <p class="subtitle">Thank you for joining ${appName}</p>
            </div>
            <div class="content">
              <p>Your account has been successfully created. You're now part of a growing community.</p>
              <p style="margin-top:12px;">Get started by exploring your dashboard and connecting with others.</p>
            </div>
            <div style="text-align:center;">
              <a href="#" class="btn">Go to Dashboard →</a>
            </div>
            <div class="divider"></div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `
  })
};

// =================== MAILJET SEND FUNCTION ===================
/**
 * Generic mailer using Mailjet HTTPS API
 * @param {string|string[]} to - Recipient email(s)
 * @param {string} subject - Email subject
 * @param {string} html - HTML body
 * @param {string} [text] - Plain text fallback
 * @param {Array} [attachments] - Optional attachments
 */
async function sendEmail(to, subject, html, text = "", attachments = []) {
  try {
    // Validate required environment variables
    if (!process.env.MJ_APIKEY_PUBLIC || !process.env.MJ_APIKEY_PRIVATE) {
      console.warn('⚠️ Mailjet API keys not configured. Email not sent.');
      console.log(`📧 [DEV] Would send email to: ${to}`);
      console.log(`📧 [DEV] Subject: ${subject}`);
      return { success: false, message: 'Mailjet not configured' };
    }

    if (!process.env.SENDER_EMAIL) {
      throw new Error('SENDER_EMAIL not configured in environment variables');
    }

    const toList = Array.isArray(to) ? to : [to];

    // Validate email addresses
    const validEmails = toList.filter(email => 
      email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    );

    if (validEmails.length === 0) {
      throw new Error('No valid email addresses provided');
    }

    const request = await mailjet.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: {
            Email: process.env.SENDER_EMAIL,
            Name: "Dashboard",
          },
          To: validEmails.map((email) => ({ Email: email })),
          Subject: subject,
          TextPart: text || html.replace(/<[^>]*>/g, '').substring(0, 500),
          HTMLPart: html,
          Attachments: attachments,
        },
      ],
    });

    console.log(`✅ Email sent successfully to: ${validEmails.join(', ')}`);
    return { success: true, data: request.body };
  } catch (error) {
    console.error("❌ Mailjet send failed:", error?.response?.data || error.message);
    
    // Log to console in development for debugging
    if (process.env.NODE_ENV === 'development') {
      console.log(`📧 [DEV] Email would be sent to: ${to}`);
      console.log(`📧 [DEV] Subject: ${subject}`);
    }
    
    throw new Error(error?.response?.data?.ErrorMessage || error.message || "Email sending failed");
  }
}

// =================== OTP SEND FUNCTION ===================
/**
 * Send OTP Email with professional template
 * @param {string} to - Recipient email
 * @param {string} otp - OTP code
 * @param {number} expiresInMins - Expiry in minutes
 * @param {string} appName - Application name
 */
async function sendOTP(to, otp, expiresInMins = 10, appName = "Dashboard") {
  try {
    const template = emailTemplates.otp(otp, expiresInMins, appName);
    const result = await sendEmail(to, template.subject, template.html);
    
    console.log(`📧 OTP sent to: ${to}`);
    return result;
  } catch (error) {
    console.error(`❌ Failed to send OTP to ${to}:`, error.message);
    throw error;
  }
}

// =================== WELCOME EMAIL FUNCTION ===================
/**
 * Send Welcome Email
 * @param {string} to - Recipient email
 * @param {string} name - User's name
 * @param {string} appName - Application name
 */
async function sendWelcomeEmail(to, name = "", appName = "Dashboard") {
  try {
    const template = emailTemplates.welcome(name, appName);
    const result = await sendEmail(to, template.subject, template.html);
    
    console.log(`📧 Welcome email sent to: ${to}`);
    return result;
  } catch (error) {
    console.error(`❌ Failed to send welcome email to ${to}:`, error.message);
    throw error;
  }
}

// =================== TEST FUNCTION ===================
/**
 * Test email configuration
 * @param {string} to - Test recipient email
 */
async function testEmailConfig(to) {
  try {
    console.log('🔧 Testing email configuration...');
    console.log(`📧 Sending test email to: ${to}`);
    
    const result = await sendEmail(
      to,
      '✅ Test Email - Mailjet Configuration',
      `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 500px; margin: auto;">
          <h2 style="color: #22c55e;">✅ Test Email Received!</h2>
          <p>Your Mailjet configuration is working correctly.</p>
          <p style="color: #6b7280; font-size: 14px;">Sent at: ${new Date().toLocaleString()}</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">This is a test email from your Dashboard application.</p>
        </div>
      `
    );
    
    console.log('✅ Test email sent successfully!');
    return result;
  } catch (error) {
    console.error('❌ Test email failed:', error.message);
    throw error;
  }
}

module.exports = { 
  sendEmail, 
  sendOTP, 
  sendWelcomeEmail, 
  testEmailConfig,
  emailTemplates 
};