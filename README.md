\# ECG PCB Business Card (NFC + Web App)



A functional \*\*ECG “PCB business card”\*\*: a pocket-sized PCB that can be read with a \*\*browser-based web app\*\*.  

Power can be provided via \*\*NFC energy harvesting\*\* (ST25DV)(only reliable with Android) or a CR1220 coin cell battery, and the ECG signal is transferred as an frequency modulated \*\*ultrasonic audio carrier\*\* to a phone/computer, where the web app visualizes the demodulated waveform and estimates \*\*heart rate / HRV\*\*.



> ⚠️ Disclaimer: This is a hobby/engineering project and \*\*not a medical device\*\*. Do not use it for diagnosis.



---



\## What’s in this repo



\- \*\*Hardware (PCB business card)\*\*

&nbsp; - Schematic + PCB design files

&nbsp; - Manufacturing outputs (Gerbers, drill, pick-and-place if applicable)

&nbsp; - BOM + assembly notes

&nbsp; - NFC antenna + resonance/tuning notes



\- \*\*Web App\*\*

&nbsp; - Browser app for signal capture + visualization



\- \*\*Docs\*\*

&nbsp; - Photos/renders

&nbsp; - “How to use” instructions

&nbsp; - Test signals / example recordings



---



\## Folder structure

/hardware

/kicad\_9\_0 # source design files

/manufacturing # gerbers/drill/pos/bom exports

/notes # tuning, measurements

LICENSE # CERN-OHL-P-2.0



/web



/docs

/images # photos/renders/screenshots

/guides # usage guide, quickstart

/data # example recordings / test signals





