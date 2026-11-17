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

Prices come from the **Prices** tab of the "Extrudo Pricing Controls" Google Sheet, as rows of Section, Item, Value, Unit and Notes. On GitHub Pages the order script sends the current rows with the Shop list, so a price changed in the sheet reaches the website within a minute. The `price-data` block near the end of `index.html` is a copy the site uses until the sheet answers, or if it can't be reached.

The "Update prices from sheet" button only appears when the site is opened inside Claude, so it does not show on GitHub Pages.

## Shop

The Shop tab on the website lists the shop's own designs from the **Shop** tab of the "Extrudo Pricing Controls" Google Sheet:

- Each row is one design: Rank (lower shows first; rows without a rank follow in sheet order), Hide from website, Name, Category, Description, the Drive link of its STL file, and the colour to show it in. The last four columns are filled in by the website.
- To add or change a design, edit its row, then open the website's Shop page signed in with the owner's Google account and tap **Update shop**. The owner's browser reads each new or changed STL through the order script, renders three pictures in the chosen colour, makes a lighter 3D copy, works out the size, volume and surface area used for pricing, and saves them to Drive (Extrudo > Shop pictures, which anyone with the link can view, and Extrudo > Shop previews, which stays private).
- The **Settings** tab has a "3D spin on Shop items" tick box. Ticked, customers can turn Shop designs around in 3D: the script sends their browser the lighter copy. Unticked, they see pictures only and the script refuses to send any 3D data. The STL files themselves never leave Drive.
- Shop orders need no upload: the order's Model files cell links straight to the design's STL.
- Sheet changes (ranks, names, the 3D setting, prices) reach the website within a minute.

## Sign-in and orders

The site has two modes, set by `LIVE_CONFIG` near the top of the script in `index.html`.

- **Demo mode** (both values empty): accounts, carts and orders stay in the visitor's browser.
- **Live mode** (both values filled in): customers sign in with Google, and every new customer and order is saved to the "Extrudo Customers and Orders" sheet in the owner's Google Drive. The Orders page shows each order's payment status, order status and tracking number as the owner updates them in the sheet.

`apps-script/Code.gs` is the small Google Apps Script that receives orders and model files, and emails the shop owner about each new order (to `NOTIFY_EMAIL` in the script, or the script's own account if that's empty; Gmail doesn't notify you about mail sent to yourself). It also emails the customer an order confirmation, sent to the address in their Google sign-in. After running `turnOnPaymentEmails` once in the Apps Script editor, setting an order's Payment status to Paid in the sheet emails that customer too, once per order. It checks every request's Google sign-in token with Google and uses the email inside the token, so a customer can only add their own orders and read their own orders. Guests cannot send anything. Customers never see the sheet itself.

### Turning on live mode

1. **Google sign-in (free).** In the Google Cloud console, create a project called Extrudo. Under APIs & Services, set up the OAuth consent screen as External, with the app name Extrudo. Then go to Credentials, choose Create credentials, then OAuth client ID, then Web application. Under Authorized JavaScript origins add `https://sainikunal90.github.io`, and copy the Client ID.
2. **The order script.** Open the "Extrudo Customers and Orders" sheet, then Extensions, then Apps Script. Replace the contents of `Code.gs` with `apps-script/Code.gs` from this repository. The Client ID is already filled in. Click Deploy, then New deployment, choose Web app, set "Execute as" to Me and "Who has access" to Anyone, and deploy. Google asks you to authorise your own script; choose Advanced, then "Go to Extrudo". Copy the Web app URL.
3. **The website.** Put the Client ID and the Web app URL into `LIVE_CONFIG` in `index.html` and commit.

## Limits of this version

- Carts stay in the visitor's browser until they check out. Each model's STL file waits in the browser too, then goes to the Extrudo > STL files folder in Drive after the order is placed, named with the order ID (EX1234AB.stl, or EX1234AB-2.stl for the second model). Files over 100 MB are refused. The customer's browser sends each file straight to Drive through an upload link the script creates, with a live progress bar. If the browser can't reach Drive directly, the file goes through the script instead, compressed first. While files upload, the Orders page shows an animated "Your order is being processed" card and asks the customer to stay on the page; the screen is kept awake where the browser allows it. If the page is closed or the connection drops, the upload carries on from where it stopped when the customer comes back.
- UPI payments are checked by hand against the reference number. Orders arrive as "Payment being checked", and the total in the sheet is what the customer's browser worked out, so check the payment and the price before printing.

## Publishing with GitHub Pages

In the repository, open Settings, then Pages. Under "Build and deployment", choose "Deploy from a branch", pick `main` and the `/ (root)` folder, and save. The site appears at `https://<your-username>.github.io/extrudo/` after a minute or two.
