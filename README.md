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

## Limits of this version

- Accounts, carts, saved addresses and orders are stored in each visitor's own browser. The shop owner does not receive orders, and uploaded STL files are not sent anywhere.
- UPI payments are checked by hand against the reference number.

A real launch needs a small backend to store orders and files, and optionally a payment gateway to confirm UPI payments automatically.

## Publishing with GitHub Pages

In the repository, open Settings, then Pages. Under "Build and deployment", choose "Deploy from a branch", pick `main` and the `/ (root)` folder, and save. The site appears at `https://<your-username>.github.io/extrudo/` after a minute or two.
