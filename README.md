# NOON

A Chrome extension that detects [palindromes](https://en.wikipedia.org/wiki/Palindrome) on web pages.

## Installation
1. Open Chrome and navigate to [chrome://extensions](chrome://extensions).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `noon/` project folder.

## How It Works
1. The content script walks all visible text nodes on the page.
2. Text nodes are grouped into contiguous runs (within the same block ancestor).
3. Each run is scanned using the **expand-around-center** technique on the cleaned (lowercase, alphanumeric-only) string, with index mapping back to the original DOM positions.
4. Only **maximal** palindromes are kept (sub-palindromes of a larger match are removed).
5. Matches are wrapped in `<mark>` elements and scrollbar markers are placed on a fixed overlay strip.

## Acknowledgements
This project is inspired by, made for, and dedicated to [the toppest palindrome enthusiast I've ever know](https://github.com/Erfaniaa) <3
