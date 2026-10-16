const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const ptp = require('pdf-to-printer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const frontendDirectory = path.resolve(__dirname, '../Frontend/public');
const uploadsDirectory = path.resolve(__dirname, 'uploads');

app.use(cors());
app.use(express.json());
app.use(express.static(frontendDirectory));
app.use('/uploads', express.static(uploadsDirectory));

fs.mkdirSync(uploadsDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDirectory),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

let orders = [];

// API 1: Multiple Files Upload Support
app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'कृपया कम से कम एक फाइल अपलोड करें!' });
    }

    const { customerName, printType, sides, copies, ratePerPage } = req.body;
    let totalPagesCount = 0;
    let processedFiles = [];

    // सभी अपलोड की गई फाइलों को एक-एक करके प्रोसेस करें
    for (let file of req.files) {
      let filePath = file.path;
      let filePages = 1;

      // अगर फाइल इमेज है तो PDF में बदलें
      if (file.mimetype.startsWith('image/')) {
        try {
          const pdfDoc = await PDFDocument.create();
          const imageBytes = fs.readFileSync(filePath);
          let image;
          if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') {
            image = await pdfDoc.embedJpg(imageBytes);
          } else if (file.mimetype === 'image/png') {
            image = await pdfDoc.embedPng(imageBytes);
          }

          if (image) {
            const page = pdfDoc.addPage([image.width, image.height]);
            page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
            const pdfBytes = await pdfDoc.save();
            const newPdfPath = filePath + '.pdf';
            fs.writeFileSync(newPdfPath, pdfBytes);
            filePath = newPdfPath;
          }
        } catch (imgErr) {
          console.error("Image Convert Error:", imgErr);
        }
        filePages = 1;
      } else if (file.mimetype === 'application/pdf') {
        try {
          const fileBytes = fs.readFileSync(filePath);
          const pdfDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: true });
          filePages = pdfDoc.getPageCount() || 1;
        } catch (pdfErr) {
          console.error("PDF Read Error:", pdfErr);
          filePages = 1;
        }
      }

      totalPagesCount += filePages;
      processedFiles.push({
        originalName: file.originalname,
        filePath: `/uploads/${path.basename(filePath)}`,
        fullPathOnDisk: path.resolve(filePath)
      });
    }

    const totalAmount = totalPagesCount * parseInt(copies || 1) * parseFloat(ratePerPage || 2);
    const orderId = 'GPH-' + Math.floor(1000 + Math.random() * 9000);

    const newOrder = {
      orderId,
      customerName: customerName || 'Guest Customer',
      files: processedFiles,
      fileName: processedFiles.length === 1 
        ? processedFiles[0].originalName 
        : `${processedFiles.length} फाइल्स (${processedFiles[0].originalName} आदि)`,
      filePath: processedFiles[0].filePath,
      totalPages: totalPagesCount,
      copies: parseInt(copies || 1),
      printType,
      sides,
      totalAmount,
      date: new Date().toLocaleDateString('en-IN'),
      time: new Date().toLocaleTimeString('en-IN'),
      status: 'Pending'
    };

    orders.unshift(newOrder);
    io.emit('new-order', newOrder);

    res.json({ success: true, order: newOrder });
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).json({ success: false, message: 'फाइल प्रोसेस करने में त्रुटि आई।' });
  }
});

// API 2: Get Orders
app.get('/api/orders', (req, res) => {
  res.json({ success: true, orders });
});

// API 3: Direct Hardware Printing (MULTIPLE FILES FIX HERE)
app.post('/api/print-direct', async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = orders.find(o => o.orderId === orderId);

    if (!order) {
      return res.status(404).json({ success: false, message: 'ऑर्डर नहीं मिला!' });
    }

    let printedCount = 0;

    // आर्डर की सभी फ़ाइलों को एक-एक करके प्रिंटर पर भेजें
    for (let fileObj of order.files) {
      const absolutePath = fileObj.fullPathOnDisk
        || path.join(uploadsDirectory, path.basename(fileObj.filePath));

      if (fs.existsSync(absolutePath)) {
        await ptp.print(absolutePath, { copies: parseInt(order.copies || 1) });
        printedCount++;
      } else {
        console.error("File not found on disk:", absolutePath);
      }
    }

    if (printedCount > 0) {
      order.status = 'Printed';
      io.emit('order-status-changed', order);
      res.json({ success: true, message: `कुल ${printedCount} फाइल्स प्रिंटर को भेज दी गईं! 🖨️` });
    } else {
      res.status(404).json({ success: false, message: 'कोई भी फ़ाइल डिस्क पर नहीं मिली!' });
    }
  } catch (error) {
    console.error("Direct Print Error:", error);
    res.status(500).json({ success: false, message: 'प्रिंटर कमांड में त्रुटि आई!' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Gaurav Printing Hub Server Active on port ${PORT}`);
});