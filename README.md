# Extrudo

Extrudo is a website for a 3D printing service in Gurgaon. Customers upload an STL file or pick a ready model, see the price change as they choose material, quality, infill and size, add several models to one cart, and pay by UPI at checkout.

The whole site is one file, `index.html`. It needs no build step and no server.

## What it does

- **Estimates:** a 3D preview on a build plate, with the price, filament weight in grams, print time and a ready-to-ship estimate.
- **Guest mode:** anyone can browse, get estimates and fill a cart without an account. Logging in is needed only at checkout.
- **Cart:** several models, each with its own settings and quantity. The setup fee and shipping are charged once per order.
- **Shipping:** the smallest box that fits the whole cart, a remote-area charge for J&K, Ladakh, the North East, Sikkim and the islands, and an "Arrives by" date from the pincode.
- **Checkout:** a delivery address that can be saved to the account, then prepaid UPI payment through a QR code with the amount filled in. The customer enters the 12-digit UPI reference number (UTR) so the payment can be matched to the order.

## Prices

The prices live in the `price-data` block near the end of `index.html`, as rows of Section, Item, Value, Unit and Notes. They are a copy of the "Extrudo Pricing Controls" Google Sheet. To change a price on this copy, edit the Value in that block and commit the file.

The "Update prices from sheet" button only appears when the site is opened inside Claude, so it does not show on GitHub Pages.

## Sign-in and orders

The site has two modes, set by `LIVE_CONFIG` near the top of the script in `index.html`.

- **Demo mode** (both values empty): accounts, carts and orders stay in the visitor's browser.
- **Live mode** (both values filled in): customers sign in with Google, and every new customer and order is saved to the "Extrudo Customers and Orders" sheet in the owner's Google Drive. The Orders page shows each order's payment status, order status and tracking number as the owner updates them in the sheet.

`apps-script/Code.gs` is the small Google Apps Script that receives orders. It checks every request's Google sign-in token with Google and uses the email inside the token, so a customer can only add their own orders and read their own orders. Guests cannot send anything. Customers never see the sheet itself.

### Turning on live mode

1. **Google sign-in (free).** In the Google Cloud console, create a project called Extrudo. Under APIs & Services, set up the OAuth consent screen as External, with the app name Extrudo. Then go to Credentials, choose Create credentials, then OAuth client ID, then Web application. Under Authorized JavaScript origins add `https://sainikunal90.github.io`, and copy the Client ID.
2. **The order script.** Open the "Extrudo Customers and Orders" sheet, then Extensions, then Apps Script. Replace the contents of `Code.gs` with `apps-script/Code.gs` from this repository, and paste the Client ID into `GOOGLE_CLIENT_ID`. Click Deploy, then New deployment, choose Web app, set "Execute as" to Me and "Who has access" to Anyone, and deploy. Google asks you to authorise your own script; choose Advanced, then "Go to Extrudo". Copy the Web app URL.
3. **The website.** Put the Client ID and the Web app URL into `LIVE_CONFIG` in `index.html` and commit.

## Limits of this version

- Carts stay in the visitor's browser until they check out, and uploaded STL files are not sent anywhere yet.
- UPI payments are checked by hand against the reference number. Orders arrive as "Payment being checked", and the total in the sheet is what the customer's browser worked out, so check the payment and the price before printing.

## Publishing with GitHub Pages

In the repository, open Settings, then Pages. Under "Build and deployment", choose "Deploy from a branch", pick `main` and the `/ (root)` folder, and save. The site appears at `https://<your-username>.github.io/extrudo/` after a minute or two.
